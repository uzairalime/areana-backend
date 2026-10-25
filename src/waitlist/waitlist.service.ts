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
    if (
      date < startOfToday() ||
      (isSameDay(date, now) && dto.startMinutes <= minutesSinceMidnight(now))
    ) {
      throw new BadRequestException('That slot has already passed');
    }

    const active = await this.prisma.slotWaitlist.count({
      where: { userId, notifiedAt: null, date: { gte: startOfToday() } },
    });
    if (active >= MAX_ACTIVE) {
      throw new BadRequestException(
        `You're already waiting on ${MAX_ACTIVE} slots — remove one first`,
      );
    }

    // The slot must exist on the day's grid and actually be taken.
    const avail = await this.availability.getAvailability(dto.courtId, dto.date);
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
    await this.prisma.slotWaitlist.deleteMany({
      where: {
        userId,
        courtId: dto.courtId,
        date,
        startMinutes: dto.startMinutes,
        notifiedAt: { not: null },
      },
    });
    try {
      return await this.prisma.slotWaitlist.create({
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
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException("You're already waiting on this slot");
      }
      throw e;
    }
  }

  listMine(userId: string) {
    return this.prisma.slotWaitlist.findMany({
      where: { userId, date: { gte: startOfToday() } },
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
