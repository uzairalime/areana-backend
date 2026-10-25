import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, Prisma, UserStatus, VenueStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { AvailabilityService } from '../availability/availability.service';
import { CourtsService } from '../courts/courts.service';
import {
  isSameDay,
  minutesSinceMidnight,
  parseDateOnly,
  slotStartAt,
  startOfToday,
} from '../common/date.util';
import { JoinWaitlistDto } from './dto';

const MAX_ACTIVE = 10;

@Injectable()
export class WaitlistService {
  constructor(
    private prisma: PrismaService,
    private availability: AvailabilityService,
    private courts: CourtsService,
  ) {}

  /** Join the waitlist for a slot that is currently taken. */
  async join(userId: string, dto: JoinWaitlistDto) {
    const court = await this.prisma.court.findFirst({
      where: {
        id: dto.courtId,
        isActive: true,
        status: 'approved',
        venue: {
          status: VenueStatus.approved,
          archivedAt: null,
          billingPaused: false,
          moderationStatus: 'none',
          owner: { status: UserStatus.active },
        },
      },
      select: {
        id: true,
        slotMinutes: true,
        venue: { select: { minAdvanceMinutes: true, maxAdvanceDays: true } },
      },
    });
    if (!court) throw new NotFoundException('Court not found');

    const date = parseDateOnly(dto.date);
    const now = new Date();
    // Round 5, P5-S46: passed = start instant, not play date — a
    // spill-start slot is not passed at 00:30 the next morning.
    if (slotStartAt({ date, startMinutes: dto.startMinutes }) <= now) {
      throw new BadRequestException('That slot has already passed');
    }

    // Round 5, P5-S57: the 10-cap is enforced inside the same
    // transaction as the create below (user-row lock serializes
    // parallel joins for one player), and entries whose slot start
    // has already passed no longer count — see the in-tx count.
    // (The old pre-check counted dead same-day entries until
    // midnight and raced parallel joins past the cap.)

    // The slot must exist on the day's grid and actually be taken.
    let avail;
    try {
      avail = await this.availability.getAvailability(dto.courtId, dto.date);
    } catch (e) {
      // Round 5, P5-S54 (waitlist leg): this path funnels through
      // getActiveCourt, so an overdue-unswept (or just-paused)
      // court surfaces as a misleading "Court not found". Say so
      // honestly instead; other errors pass through untouched.
      if ((e as Error)?.message?.includes('Court not found')) {
        throw new NotFoundException(
          'This court is no longer bookable — it may be paused or past its payment grace period',
        );
      }
      throw e;
    }
    const slot = avail.slots.find((s) => s.startMinutes === dto.startMinutes);
    if (!slot) throw new BadRequestException('No such slot on that day');
    if (slot.available) {
      throw new BadRequestException('That slot is open — you can book it now');
    }

    // A waitlist entry must be able to FIRE (Round 4): the old code
    // accepted any unavailable slot, including ones that can never
    // open up — inside the min-advance notice window, blocked by the
    // arena, or beyond the max-advance horizon — and those entries
    // sat against the 10-cap forever. Availability marks a slot
    // unavailable for exactly clash / too-soon / too-far, so the
    // reason is decomposed the same way: bookings (this date +
    // overnight spill both ways) and blocked ranges make up clash.
    const prevDay = new Date(date);
    prevDay.setDate(prevDay.getDate() - 1);
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    const [dayBookings, prevBookings, nextBookings, blocked] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          courtId: dto.courtId,
          date,
          status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
        },
        select: { startMinutes: true, endMinutes: true },
      }),
      this.prisma.booking.findMany({
        where: {
          courtId: dto.courtId,
          date: prevDay,
          status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
          endMinutes: { gt: 1440 },
        },
        select: { startMinutes: true, endMinutes: true },
      }),
      this.prisma.booking.findMany({
        where: {
          courtId: dto.courtId,
          date: nextDay,
          status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
          startMinutes: { lt: 360 },
        },
        select: { startMinutes: true, endMinutes: true },
      }),
      this.courts.blockedRangesForDate(dto.courtId, date),
    ]);
    const occupied =
      dayBookings.some(
        (b) => dto.startMinutes < b.endMinutes && slot.endMinutes > b.startMinutes,
      ) ||
      prevBookings.some(
        (b) =>
          dto.startMinutes < b.endMinutes - 1440 &&
          slot.endMinutes > b.startMinutes - 1440,
      ) ||
      nextBookings.some(
        (b) =>
          dto.startMinutes < b.endMinutes + 1440 &&
          slot.endMinutes > b.startMinutes + 1440,
      );
    const blockedHit = blocked.some(
      (r) => dto.startMinutes < r.endMinutes && slot.endMinutes > r.startMinutes,
    );
    const slotAt = new Date(date);
    slotAt.setHours(
      Math.floor(dto.startMinutes / 60),
      dto.startMinutes % 60,
      0,
      0,
    );
    const tooSoon =
      slotAt < new Date(now.getTime() + court.venue.minAdvanceMinutes * 60_000);
    const tooFar =
      slotAt > new Date(now.getTime() + court.venue.maxAdvanceDays * 24 * 3600_000);
    // Inside the notice window the slot can never be booked, even if
    // its booking is cancelled — the waiter would be pinged into a
    // booking the window check refuses. Refused whether or not a
    // booking currently holds it.
    if (tooSoon) {
      throw new BadRequestException(
        `This slot starts in under ${court.venue.minAdvanceMinutes} minutes — inside the arena's notice window — so it can't be booked even if it frees up`,
      );
    }
    if (!occupied) {
      if (blockedHit) {
        throw new BadRequestException(
          'This slot is blocked by the arena, not booked — there is no booking to wait on, so a waitlist entry here would never fire',
        );
      }
      if (tooFar) {
        // Too far out means too EARLY, not too late: the booking
        // window has not opened yet. This is the case where the
        // refusal can honestly state when the slot becomes bookable
        // (a notice-window slot, by contrast, never becomes
        // bookable as time passes — it only gets closer).
        const opensAt = new Date(
          slotAt.getTime() - court.venue.maxAdvanceDays * 24 * 3600_000,
        );
        const pad = (v: number) => String(v).padStart(2, '0');
        throw new BadRequestException(
          `Bookings for this slot open on ${opensAt.getFullYear()}-${pad(opensAt.getMonth() + 1)}-${pad(opensAt.getDate())} at ${pad(opensAt.getHours())}:${pad(opensAt.getMinutes())} — come back then to book it directly`,
        );
      }
      // Nothing holds the slot and it is inside the booking window:
      // it freed between the availability read and this check, so it
      // is bookable now rather than waitlistable.
      throw new BadRequestException('That slot is open — you can book it now');
    }

    // A notified entry must not block re-joining forever (Round 4):
    // clearing it on re-join lets the player wait again after a
    // ping they missed or could not act on. An active (un-notified)
    // entry still conflicts below.
    // Round 5, P5-S56 + P5-S57: the delete + cap-check + create run
    // in ONE transaction, serialized per player by a lock on the
    // user row — parallel joins can no longer both read 9 and both
    // create, and a re-join's delete cannot strand a row created
    // against a stale cap read.
    let entry;
    try {
      entry = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        const actives = await tx.slotWaitlist.findMany({
          where: { userId, notifiedAt: null },
          select: { date: true, startMinutes: true },
        });
        const activeCount = actives.filter(
          (e) => slotStartAt(e) > new Date(),
        ).length;
        if (activeCount >= MAX_ACTIVE) {
          throw new BadRequestException(
            `You're already waiting on ${MAX_ACTIVE} slots — remove one first`,
          );
        }
        await tx.slotWaitlist.deleteMany({
          where: {
            userId,
            courtId: dto.courtId,
            date,
            startMinutes: dto.startMinutes,
            notifiedAt: { not: null },
          },
        });
        return tx.slotWaitlist.create({
          data: {
            userId,
            courtId: dto.courtId,
            date,
            startMinutes: dto.startMinutes,
            // The waited slot size (Round 4): pings must step the
            // waited grid, not the court's current slot length.
            slotMinutes: court.slotMinutes,
          },
        });
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException("You're already waiting on this slot");
      }
      throw e;
    }
    // Round 5, P5-S56: the slot may have freed between the
    // availability read above and this create (a cancel whose
    // notify snapshot ran before this row existed). Re-check now:
    // if it is free, drop the just-created row and return
    // "book it now" instead of a waitlist row that could never fire.
    const fresh = await this.availability
      .getAvailability(dto.courtId, dto.date)
      .catch(() => null);
    const freshSlot = fresh?.slots.find((s) => s.startMinutes === dto.startMinutes);
    if (freshSlot?.available) {
      await this.prisma.slotWaitlist
        .delete({ where: { id: entry.id } })
        .catch(() => {});
      return {
        bookNow: true,
        message: 'That slot is open — you can book it now',
        courtId: dto.courtId,
        date: dto.date,
        startMinutes: dto.startMinutes,
      };
    }
    return entry;
  }

  listMine(userId: string) {
    // Round 5, P5-T20: keep only slots not yet started, by start
    // instant — an earlier-today slot that never freed no longer
    // shows "Waiting" until midnight, and a yesterday spill-start
    // slot still upcoming after midnight still shows.
    const today = startOfToday();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const nowMin = minutesSinceMidnight();
    return this.prisma.slotWaitlist.findMany({
      where: {
        userId,
        OR: [
          { date: { gt: today } },
          { date: today, startMinutes: { gt: nowMin } },
          { date: yesterday, startMinutes: { gt: 1440 + nowMin } },
        ],
      },
      include: {
        court: {
          select: {
            name: true,
            sport: true,
            venue: { select: { id: true, name: true, city: true } },
          },
        },
      },
      orderBy: [{ date: 'asc' }, { startMinutes: 'asc' }],
    });
  }

  async remove(userId: string, id: string) {
    const entry = await this.prisma.slotWaitlist.findFirst({
      where: { id, userId },
    });
    if (!entry) throw new NotFoundException('Waitlist entry not found');
    await this.prisma.slotWaitlist.delete({ where: { id } });
    return { message: 'Removed from the waitlist' };
  }
}
