import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { offsetPageFromDb, pageLimit } from '../common/pagination';
import { CourtsService } from '../courts/courts.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PromosService } from '../promos/promos.service';
import {
  isSameDay,
  minutesSinceMidnight,
  parseDateOnly,
  startOfToday,
} from '../common/date.util';
import { CreateBookingDto, CreateRecurringDto, JoinSharedDto, MyBookingsQueryDto } from './dto';

export interface CreateBookingInput extends CreateBookingDto {
  userId?: string;
  guestName?: string;
  recurrenceId?: string;
  /** Walk-ins / staff-created bookings skip the advance-notice window. */
  skipWindowCheck?: boolean;
  /** Recurring-series occurrences skip only the max-advance window. */
  skipMaxAdvance?: boolean;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const UPCOMING: BookingStatus[] = [BookingStatus.pending, BookingStatus.confirmed];
function shortCode(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

@Injectable()
export class BookingsService {
  constructor(
    private prisma: PrismaService,
    private courts: CourtsService,
    private promos: PromosService,
    private notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------------ create
  /**
   * Creates a booking. Safety layers:
   *  1. Court active + venue approved.
   *  2. Slot aligned to grid, within hours, within venue booking window.
   *  3. Overlap check across the FULL range (multi-slot) against pending/confirmed.
   *  4. @@unique(courtId, date, startMinutes) as the final backstop.
   */
  async create(input: CreateBookingInput) {
    const court = await this.courts.getActiveCourt(input.courtId);
    const date = parseDateOnly(input.date);
    const slotCount = input.slotCount ?? 1;
    const { startMinutes } = input;

    await this.validateSlotGrid(court, date, startMinutes, slotCount);
    const endMinutes = startMinutes + court.slotMinutes * slotCount;
    if (!input.skipWindowCheck) {
      this.validateWindow(court, date, startMinutes, input.skipMaxAdvance);
    }

    await this.assertNoOverlap(court.id, date, startMinutes, endMinutes);

    // Per-slot pricing: each slot takes the rate of the price window
    // covering it (peak/off-peak), else the court's base rate — so a
    // booking spanning the peak boundary prices each hour correctly.
    const priceWindows = await this.courts.priceWindowsForDate(court.id, date);
    const baseRate = Number(court.pricePerHour);
    let gross = 0;
    for (let i = 0; i < slotCount; i++) {
      const rate = this.courts.priceRateForSlot(
        priceWindows,
        baseRate,
        startMinutes + i * court.slotMinutes,
      );
      gross += rate * (court.slotMinutes / 60);
    }
    // Round the gross before any discount math: 45-minute slots at odd
    // hourly rates otherwise store fractional paisa, and GMV sums drift
    // from the rounded receipts players see.
    gross = Math.round(gross * 100) / 100;
    let discount = 0;
    let promo: { id: string } | null = null;
    if (input.promoCode && input.userId) {
      const res = await this.promos.validatePromo(input.promoCode, input.userId, gross, court.venueId);
      discount = res.discount;
      promo = res.promo;
    }

    const booking = await this.prisma.$transaction(async (tx) => {
      const b = await tx.booking.create({
        data: {
          userId: input.userId,
          guestName: input.guestName,
          venueId: court.venueId,
          courtId: court.id,
          date,
          startMinutes,
          endMinutes,
          // Never store a negative price: a discount larger than the
          // gross (e.g. a misconfigured promo) floors at zero.
          totalPrice: Math.max(0, gross - discount),
          discountAmount: discount,
          promoCodeId: promo?.id,
          status: court.venue.autoAccept ? BookingStatus.confirmed : BookingStatus.pending,
          shareCode: shortCode(8),
          checkInCode: shortCode(10),
          recurrenceId: input.recurrenceId,
        },
        include: {
          court: { select: { name: true, sport: true } },
          venue: { select: { name: true, address: true, owner: { select: { email: true } } } },
        },
      });
      if (promo && input.userId) {
        await this.promos.applyPromo(promo.id, input.userId, b.id, tx);
      }
      return b;
    });

    // Notify the arena owner (email) — only for player-made requests, not walk-ins.
    const ownerEmail = (booking.venue as any).owner?.email;
    if (ownerEmail && input.userId && booking.status === BookingStatus.pending) {
      const hh = String(Math.floor(startMinutes / 60)).padStart(2, '0');
      const mm = String(startMinutes % 60).padStart(2, '0');
      await this.notifications.notifyOwnerNewBooking(
        ownerEmail,
        booking.venue.name,
        `${booking.court.name} — ${input.date} ${hh}:${mm} (${slotCount} slot${slotCount > 1 ? 's' : ''}), Rs ${Number(booking.totalPrice).toFixed(0)}`,
      ).catch(() => {});
    }
    return booking;
  }

  /**
   * The booking must sit fully inside ONE of the day's open windows
   * (weekly template or default hours) and align to the slot grid
   * anchored at that window's start.
   */
  private async validateSlotGrid(
    court: any,
    date: Date,
    startMinutes: number,
    slotCount: number,
  ) {
    const endMinutes = startMinutes + court.slotMinutes * slotCount;
    const windows = await this.courts.windowsForDate(court, date);
    if (windows.length === 0) {
      throw new BadRequestException('Court is closed on this day');
    }
    const w = windows.find(
      (x) => startMinutes >= x.startMinutes && endMinutes <= x.endMinutes,
    );
    if (!w || (startMinutes - w.startMinutes) % court.slotMinutes !== 0) {
      throw new BadRequestException('Slot is outside court hours or misaligned');
    }
  }

  private validateWindow(
    court: any,
    date: Date,
    startMinutes: number,
    skipMaxAdvance = false,
  ) {
    const now = new Date();
    const bookingAt = new Date(date);
    bookingAt.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);

    const minAt = new Date(now.getTime() + court.venue.minAdvanceMinutes * 60_000);
    if (bookingAt < minAt) {
      throw new BadRequestException(
        `Bookings need at least ${court.venue.minAdvanceMinutes} minutes notice`,
      );
    }
    // A recurring series is a standing commitment the owner approves —
    // its later occurrences are exempt from the max-advance window
    // (min-advance above still applies to every occurrence).
    if (!skipMaxAdvance) {
      const maxDate = startOfToday();
      maxDate.setDate(maxDate.getDate() + court.venue.maxAdvanceDays);
      if (date > maxDate) {
        throw new BadRequestException(`Bookings open only ${court.venue.maxAdvanceDays} days ahead`);
      }
    }
    if (bookingAt <= now) throw new BadRequestException('Cannot book a slot in the past');
  }

  private async assertNoOverlap(courtId: string, date: Date, startMinutes: number, endMinutes: number) {
    const clash = await this.prisma.booking.findFirst({
      where: {
        courtId,
        date,
        status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
        startMinutes: { lt: endMinutes },
        endMinutes: { gt: startMinutes },
      },
      select: { id: true },
    });
    if (clash) throw new ConflictException('Slot overlaps an existing booking');

    const ranges = await this.courts.blockedRangesForDate(courtId, date);
    if (
      ranges.some((r) => startMinutes < r.endMinutes && endMinutes > r.startMinutes)
    ) {
      throw new ConflictException('Slot is blocked by the arena');
    }

    // Overnight spill: a booking ending after midnight (endMinutes >
    // 1440, stored on the evening's date) must not clash with early
    // bookings stored on the next date — and vice versa.
    if (endMinutes > 1440) {
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);
      const spillClash = await this.prisma.booking.findFirst({
        where: {
          courtId,
          date: nextDate,
          status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
          startMinutes: { lt: endMinutes - 1440 },
          endMinutes: { gt: 0 },
        },
        select: { id: true },
      });
      if (spillClash) throw new ConflictException('Slot overlaps an existing booking');
    }
    if (startMinutes < 360) {
      const prevDate = new Date(date);
      prevDate.setDate(prevDate.getDate() - 1);
      const prev = await this.prisma.booking.findMany({
        where: {
          courtId,
          date: prevDate,
          status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
          endMinutes: { gt: 1440 },
        },
        select: { startMinutes: true, endMinutes: true },
      });
      if (
        prev.some(
          (b) => b.startMinutes - 1440 < endMinutes && b.endMinutes - 1440 > startMinutes,
        )
      ) {
        throw new ConflictException('Slot overlaps an existing booking');
      }
    }
  }

  // -------------------------------------------------------------- recurring
  async createRecurring(userId: string, dto: CreateRecurringDto) {
    if (dto.dayOfWeek < 0 || dto.dayOfWeek > 6) {
      throw new BadRequestException('dayOfWeek must be 0 (Sun) – 6 (Sat)');
    }
    if (dto.occurrences > 26) {
      throw new BadRequestException('Max 26 occurrences (6 months)');
    }
    const recurrenceId = `rec_${Date.now().toString(36)}_${shortCode(4)}`;
    const created: any[] = [];
    const skipped: { date: string; reason: string }[] = [];

    // Next N dates matching dayOfWeek.
    const dates: Date[] = [];
    const d = startOfToday();
    d.setDate(d.getDate() + 1);
    while (dates.length < dto.occurrences && dates.length < 365) {
      if (d.getDay() === dto.dayOfWeek) dates.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }

    for (const date of dates) {
      const ds = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      try {
        const b = await this.create({
          courtId: dto.courtId,
          date: ds,
          startMinutes: dto.startMinutes,
          slotCount: dto.slotCount ?? 1,
          userId,
          recurrenceId,
          skipMaxAdvance: true,
        });
        created.push(b);
      } catch (e: any) {
        skipped.push({ date: ds, reason: e.message ?? 'Unavailable' });
      }
    }
    return { recurrenceId, created, skipped };
  }

  async cancelRecurringSeries(userId: string, recurrenceId: string) {
    const candidates = await this.prisma.booking.findMany({
      where: {
        recurrenceId,
        userId,
        status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
        date: { gte: startOfToday() },
      },
      select: { id: true, date: true, startMinutes: true },
    });
    // The started-check applies to today's occurrence too: a series
    // cancel must not kill a slot that is already in play — it stays
    // confirmed while the rest of the series is cancelled.
    const now = new Date();
    const nowMin = minutesSinceMidnight(now);
    const affected = candidates.filter(
      (b) =>
        !(
          b.date < startOfToday() ||
          (isSameDay(b.date, now) && b.startMinutes <= nowMin)
        ),
    );
    const res = await this.prisma.booking.updateMany({
      where: { id: { in: affected.map((b) => b.id) } },
      data: { status: BookingStatus.cancelled },
    });
    for (const b of affected) {
      await this.rejectPendingReschedules(b.id);
      await this.releasePromo(b.id);
      await this.cleanupGamePost(b.id, 'The host cancelled their booking, so this game is off.');
      const full = await this.prisma.booking.findUnique({
        where: { id: b.id },
        select: { courtId: true, date: true, startMinutes: true, endMinutes: true },
      });
      if (full) await this.notifyWaitlist(full);
    }
    return { cancelled: res.count };
  }

  // ------------------------------------------------------------------ read
  async listMine(userId: string, query: MyBookingsQueryDto) {
    const today = startOfToday();
    const where =
      query.filter === 'past'
        ? {
            userId,
            OR: [
              { date: { lt: today } },
              { status: { in: [BookingStatus.cancelled, BookingStatus.completed, BookingStatus.no_show] } },
            ],
          }
        : {
            userId,
            date: { gte: today },
            status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
          };

    const page = query.page ?? 1;
    const limit = pageLimit(query.limit, 20);
    const [total, items] = await Promise.all([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          court: { select: { name: true, sport: true } },
        // images/photos power the venue photo on the player's booking
        // cards — without them the cards rendered placeholders forever.
        venue: { select: { name: true, address: true, city: true, lat: true, lng: true, images: true, photos: true } },
        gamePost: {
          select: {
            id: true,
            playersNeeded: true,
            squadSize: true,
            level: true,
            status: true,
            _count: {
              select: { participants: { where: { status: 'joined' } } },
            },
          },
        },
        _count: { select: { participants: true } },
      },
        orderBy: [{ date: 'asc' }, { startMinutes: 'asc' }],
      }),
    ]);
    return offsetPageFromDb(items, total, page, limit);
  }

  async cancelMine(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, userId } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (!UPCOMING.includes(booking.status)) {
      throw new BadRequestException('Only upcoming bookings can be cancelled');
    }
    const now = new Date();
    const started =
      booking.date < startOfToday() ||
      (isSameDay(booking.date, now) && booking.startMinutes <= minutesSinceMidnight(now));
    if (started) throw new BadRequestException('Cannot cancel a slot that already started');

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.cancelled },
    });
    await this.rejectPendingReschedules(bookingId);
    await this.cleanupGamePost(bookingId, 'The host cancelled their booking, so this game is off.');
    await this.notifyWaitlist(booking);
    await this.releasePromo(bookingId);
    return updated;
  }

  // ------------------------------------------------------------------ share
  async shareBooking(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, userId } });
    if (!booking) throw new NotFoundException('Booking not found');
    let shareCode = booking.shareCode;
    if (!shareCode) {
      shareCode = shortCode(8);
      await this.prisma.booking.update({ where: { id: bookingId }, data: { shareCode } });
    }
    return { shareCode, joinUrl: `/join/${shareCode}` };
  }

  /** Public: what a friend sees when opening a share link. */
  async getShared(shareCode: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { shareCode },
      include: {
        court: { select: { name: true, sport: true } },
        venue: { select: { name: true, address: true, city: true, images: true, photos: true } },
        participants: { select: { name: true, joinedAt: true } },
      },
    });
    if (!booking || booking.status === BookingStatus.cancelled) {
      throw new NotFoundException('Booking link is invalid or expired');
    }
    const { checkInCode: _c, ...safe } = booking as any;
    return safe;
  }

  /**
   * A game post lives and dies with its booking: when the booking is
   * cancelled, delete the post and tell everyone who joined it.
   */
  async cleanupGamePost(bookingId: string, reason: string) {
    const post = await this.prisma.gamePost.findUnique({
      where: { bookingId },
    });
    if (!post) return;
    const squad = await this.prisma.gameParticipant.findMany({
      where: { postId: post.id, userId: { not: null } },
      select: { userId: true },
    });
    for (const s of squad) {
      await this.notifications
        .pushToUser(s.userId!, {
          title: 'Game cancelled',
          body: reason,
          data: { type: 'game_cancelled' },
        })
        .catch(() => {});
    }
    await this.prisma.gamePost.delete({ where: { id: post.id } });
  }

  /**
   * When a booked slot frees up (cancellation, reschedule-away), tell
   * everyone waitlisted for exactly that slot — first come, first served.
   */
  async notifyWaitlist(booking: {
    courtId: string;
    date: Date;
    startMinutes: number;
    endMinutes: number;
  }) {
    const court = await this.prisma.court.findUnique({
      where: { id: booking.courtId },
      include: { venue: { select: { name: true } } },
    });
    if (!court) return;
    // Every slot in the freed range — a 2-hour cancellation frees two
    // waitlist slots, not just the first.
    for (
      let s = booking.startMinutes;
      s < booking.endMinutes;
      s += court.slotMinutes
    ) {
      const entries = await this.prisma.slotWaitlist.findMany({
        where: {
          courtId: booking.courtId,
          date: booking.date,
          startMinutes: s,
          notifiedAt: null,
        },
      });
      if (entries.length === 0) continue;
      const hh = String(Math.floor(s / 60) % 24).padStart(2, '0');
      const mm = String(s % 60).padStart(2, '0');
      for (const e of entries) {
        await this.notifications
          .pushToUser(e.userId, {
            title: 'A slot just opened up',
            body: `${court.venue.name} · ${court.name} on ${booking.date.toISOString().slice(0, 10)} at ${hh}:${mm} is free again — grab it before someone else does.`,
            data: { type: 'slot_opened' },
          })
          .catch(() => {});
      }
      await this.prisma.slotWaitlist.updateMany({
        where: { id: { in: entries.map((e) => e.id) } },
        data: { notifiedAt: new Date() },
      });
    }
  }

  async joinShared(shareCode: string, dto: JoinSharedDto, userId?: string) {
    const booking = await this.prisma.booking.findUnique({ where: { shareCode } });
    if (!booking || booking.status === BookingStatus.cancelled) {
      throw new NotFoundException('Booking link is invalid or expired');
    }
    // A link for a game that already happened can't take new joiners.
    if (
      booking.date < startOfToday() ||
      (isSameDay(booking.date, startOfToday()) &&
        booking.endMinutes <= minutesSinceMidnight())
    ) {
      throw new BadRequestException('This game has already taken place');
    }
    // One join per phone number — stops accidental (or spammed) duplicates.
    if (dto.phone) {
      const dupe = await this.prisma.bookingParticipant.findFirst({
        where: { bookingId: booking.id, phone: dto.phone },
      });
      if (dupe) {
        throw new ConflictException('This number has already joined this game');
      }
    }
    let name = dto.name;
    if (userId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (user?.name) name = user.name;
    }
    return this.prisma.bookingParticipant.create({
      data: { bookingId: booking.id, name, phone: dto.phone },
    });
  }

  // ------------------------------------------------------- reschedule requests
  /** Player asks to move a confirmed booking; the original slot stays held. */
  async requestReschedule(userId: string, bookingId: string, dateStr: string, startMinutes: number) {
    const booking = await this.prisma.booking.findFirst({ where: { id: bookingId, userId } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.status !== BookingStatus.confirmed) {
      throw new BadRequestException('Only confirmed bookings can be rescheduled');
    }
    // The original slot must not have started (or ended), and a booking
    // already checked in can no longer move — otherwise an in-progress
    // game could be teleported to another day.
    if (booking.checkedInAt) {
      throw new BadRequestException('A checked-in booking cannot be rescheduled');
    }
    const now = new Date();
    const started =
      booking.date < startOfToday() ||
      (isSameDay(booking.date, now) && booking.startMinutes <= minutesSinceMidnight(now));
    if (started) {
      throw new BadRequestException('Cannot reschedule a slot that already started');
    }
    const existing = await this.prisma.rescheduleRequest.findFirst({
      where: { bookingId, status: 'pending' },
    });
    if (existing) throw new ConflictException('A reschedule request is already pending');

    const date = parseDateOnly(dateStr);
    const duration = booking.endMinutes - booking.startMinutes;
    const endMinutes = startMinutes + duration;
    const slotAt = new Date(date);
    slotAt.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
    if (slotAt <= new Date()) throw new BadRequestException('New slot must be in the future');

    return this.prisma.rescheduleRequest.create({
      data: {
        bookingId,
        requestedDate: date,
        requestedStartMinutes: startMinutes,
        requestedEndMinutes: endMinutes,
      },
    });
  }

  // ------------------------------------------------------- owner operations
  /** Owner/staff act on bookings of their venues (ownership verified by caller). */
  async acceptBooking(bookingId: string) {
    const booking = await this.getPending(bookingId);
    // Atomic claim: only one decider can move the booking out of pending;
    // a simultaneous second decision gets 'already decided' instead of
    // silently overwriting the first.
    const claimed = await this.prisma.booking.updateMany({
      where: { id: bookingId, status: BookingStatus.pending },
      data: { status: BookingStatus.confirmed },
    });
    if (claimed.count === 0) {
      throw new BadRequestException('This booking has already been decided');
    }
    const updated = await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    if (booking.userId) {
      await this.notifications.notifyPlayerDecision(booking.userId, true, booking.venue.name, this.fmtWhen(booking)).catch(() => {});
    }
    return updated;
  }

  async rejectBooking(bookingId: string, reason?: string) {
    const booking = await this.getPending(bookingId);
    const claimed = await this.prisma.booking.updateMany({
      where: { id: bookingId, status: BookingStatus.pending },
      data: { status: BookingStatus.cancelled },
    });
    if (claimed.count === 0) {
      throw new BadRequestException('This booking has already been decided');
    }
    const updated = await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    await this.releasePromo(bookingId);
    if (booking.userId) {
      await this.notifications.notifyPlayerDecision(booking.userId, false, booking.venue.name, this.fmtWhen(booking), reason).catch(() => {});
    }
    return updated;
  }

  async acceptSeries(recurrenceId: string, venueId: string) {
    const pendings = await this.prisma.booking.findMany({
      where: { recurrenceId, venueId, status: BookingStatus.pending },
      include: { venue: { select: { name: true } } },
    });
    const accepted: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const b of pendings) {
      try {
        await this.assertNoOverlap(b.courtId, b.date, b.startMinutes, b.endMinutes);
        await this.prisma.booking.update({ where: { id: b.id }, data: { status: BookingStatus.confirmed } });
        accepted.push(b.id);
        if (b.userId) {
          await this.notifications.notifyPlayerDecision(b.userId, true, b.venue.name, this.fmtWhen(b)).catch(() => {});
        }
      } catch {
        await this.prisma.booking.update({ where: { id: b.id }, data: { status: BookingStatus.cancelled } });
        await this.releasePromo(b.id);
        skipped.push({ id: b.id, reason: 'Slot no longer available' });
      }
    }
    return { accepted, skipped };
  }

  /**
   * Defense in depth for check-in: bookings are created through the
   * getActiveCourt choke point, but a venue sanctioned, paused, or
   * suspended afterwards must not keep accepting check-ins for
   * bookings that slipped through (e.g. made before the sanction).
   */
  private async assertVenueAcceptsCheckIns(venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: {
        status: true,
        archivedAt: true,
        billingPaused: true,
        moderationStatus: true,
        owner: { select: { status: true } },
      },
    });
    if (
      !venue ||
      venue.status !== 'approved' ||
      venue.archivedAt ||
      venue.billingPaused ||
      venue.moderationStatus !== 'none' ||
      venue.owner.status !== 'active'
    ) {
      throw new BadRequestException('This arena is not currently accepting check-ins');
    }
  }

  async checkInByCode(checkInCode: string, venueId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { checkInCode, venueId },
      include: {
        court: { select: { name: true } },
        user: { select: { name: true, phone: true } },
      },
    });
    if (!booking) throw new NotFoundException('Invalid check-in code');
    await this.assertVenueAcceptsCheckIns(venueId);
    // Scan responses used to return bare booking details, leaving the
    // panel to guess whether check-in would succeed. The flag mirrors
    // checkIn's own rules exactly: confirmed, not already checked in,
    // game day, and inside [start − 30min, end]. Non-confirmed codes
    // are always false — a pending/cancelled booking is never
    // check-in-able, whatever the clock says.
    const now = new Date();
    const nowMin = minutesSinceMidnight(now);
    const canCheckIn =
      booking.status === BookingStatus.confirmed &&
      !booking.checkedInAt &&
      isSameDay(booking.date, now) &&
      nowMin >= booking.startMinutes - 30 &&
      nowMin <= booking.endMinutes;
    return { ...booking, canCheckIn };
  }

  async checkIn(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
    await this.assertVenueAcceptsCheckIns(booking.venueId);
    if (booking.checkedInAt) {
      throw new BadRequestException('This booking is already checked in');
    }
    if (booking.status !== BookingStatus.confirmed) {
      throw new BadRequestException('Only confirmed bookings can be checked in');
    }
    // Check-in window: game day only, from 30 minutes before the slot
    // until the slot ends. Anything else is almost certainly a wrong scan.
    const today = startOfToday();
    if (!isSameDay(booking.date, today)) {
      throw new BadRequestException('Check-in is only available on the day of the booking');
    }
    const nowMin = minutesSinceMidnight();
    if (nowMin < booking.startMinutes - 30) {
      throw new BadRequestException('Check-in opens 30 minutes before the slot');
    }
    if (nowMin > booking.endMinutes) {
      throw new BadRequestException('This slot has already ended');
    }
    return this.prisma.booking.update({
      where: { id: bookingId },
      data: { checkedInAt: new Date() },
    });
  }

  async markNoShow(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
    // Idempotent: re-marking an already no-show booking changes nothing
    // (in particular, it must not add a second strike).
    if (booking.status === BookingStatus.no_show) return booking;
    if (booking.status !== BookingStatus.confirmed) {
      throw new BadRequestException('Only confirmed bookings can be marked as no-show');
    }
    // A player who checked in played the game — striking them would be
    // a data error, not a no-show.
    if (booking.checkedInAt) {
      throw new BadRequestException('A checked-in booking cannot be marked as no-show');
    }
    // A no-show can only be recorded once the slot has actually ended.
    const today = startOfToday();
    const ended =
      booking.date < today ||
      (isSameDay(booking.date, today) && booking.endMinutes <= minutesSinceMidnight());
    if (!ended) {
      throw new BadRequestException('A booking can only be marked no-show after its slot ends');
    }
    // Atomic claim: the status condition inside the UPDATE means two
    // staff members marking at once can't both pass — one strike total.
    const claimed = await this.prisma.booking.updateMany({
      where: { id: bookingId, status: BookingStatus.confirmed },
      data: { status: BookingStatus.no_show },
    });
    if (claimed.count === 0) {
      return this.prisma.booking.findUnique({ where: { id: bookingId } });
    }
    const updated = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    // A no-showed booking must never be resurrected by a stale pending
    // reschedule request.
    await this.rejectPendingReschedules(bookingId);
    if (booking.userId) {
      await this.recordNoShowStrike(booking.userId);
    }
    return updated;
  }

  /**
   * One no-show strike, shared by the owner path (markNoShow) and the
   * dispute path (admin confirm_no_show): increment, then suspend at
   * the configured strike limit with the full cascade.
   */
  async recordNoShowStrike(userId: string) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { noShowCount: { increment: 1 } },
    });
    const limit = parseInt(
      (await this.prisma.setting.findUnique({ where: { key: 'noShowStrikeLimit' } }))?.value ?? '3',
      10,
    );
    if (user.noShowCount >= limit && user.status === UserStatus.active) {
      await this.suspendPlayerWithCascade(userId);
    }
    return user.noShowCount;
  }

  /** Refund a booking's promo (uses are given back on cancel/expiry). */
  async releasePromo(bookingId: string) {
    await this.promos.refundBookingPromo(bookingId);
  }

  /**
   * Sanction / suspension / overdue-pause policy: when a venue stops
   * being bookable, its upcoming bookings do not stand — they are
   * cancelled, their game posts and waitlists are cleaned up, promos
   * are refunded, and every affected player is told why.
   */
  async cancelVenueUpcomingBookings(venueId: string, reason: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { name: true },
    });
    const upcoming = await this.prisma.booking.findMany({
      where: {
        venueId,
        date: { gte: startOfToday() },
        status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
      },
      select: {
        id: true,
        userId: true,
        date: true,
        courtId: true,
        startMinutes: true,
        endMinutes: true,
      },
    });
    for (const b of upcoming) {
      await this.prisma.booking.update({
        where: { id: b.id },
        data: { status: BookingStatus.cancelled },
      });
      await this.rejectPendingReschedules(b.id);
      await this.cleanupGamePost(b.id, 'The arena cancelled the booking, so this game is off.');
      await this.notifyWaitlist(b);
      await this.releasePromo(b.id);
      if (b.userId) {
        await this.notifications
          .pushToUser(b.userId, {
            title: 'Booking cancelled',
            body: `Your booking at ${venue?.name ?? 'the arena'} on ${b.date.toISOString().slice(0, 10)} was cancelled: ${reason}.`,
            data: { type: 'booking_cancelled', venueId },
          })
          .catch(() => {});
      }
    }
    return upcoming.length;
  }

  /**
   * Suspends a player and unwinds their future: upcoming bookings are
   * cancelled, the player is told once, and each affected venue owner
   * gets an email. (Owner suspensions deliberately do NOT use this —
   * their bookings stand and venues pause; see round-3 policy.)
   */
  /**
   * Cancel every future booking of a player, with the full wake: linked
   * game posts deleted + squads notified, freed slots pinged to their
   * waitlists, venue owners emailed. Shared by suspension + deletion.
   * Returns how many bookings were cancelled.
   */
  async cancelFutureBookings(userId: string, ownerNote: string) {
    const future = await this.prisma.booking.findMany({
      where: {
        userId,
        date: { gte: startOfToday() },
        status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
      },
      include: {
        venue: { select: { name: true, owner: { select: { email: true } } } },
      },
    });
    for (const b of future) {
      await this.prisma.booking.update({
        where: { id: b.id },
        data: { status: BookingStatus.cancelled },
      });
      await this.rejectPendingReschedules(b.id);
      await this.releasePromo(b.id);
      await this.cleanupGamePost(b.id, 'This game is off — the host is no longer on Areana.');
      await this.notifyWaitlist(b);
      if (b.venue.owner?.email) {
        await this.notifications
          .notifyOwnerNewBooking(
            b.venue.owner.email,
            b.venue.name,
            `A booking on ${b.date.toISOString().slice(0, 10)} was cancelled ${ownerNote}.`,
          )
          .catch(() => {});
      }
    }
    return future.length;
  }

  /**
   * Pull a player out of every game they joined or asked to join:
   * squad spots reopen (full games go back to open) and hosts hear
   * about it. Used by suspension and account deletion.
   */
  async exitGames(userId: string) {
    const rows = await this.prisma.gameParticipant.findMany({
      where: { userId },
      include: {
        post: {
          select: {
            id: true,
            creatorId: true,
            sport: true,
            status: true,
            date: true,
            startMinutes: true,
          },
        },
      },
    });
    if (rows.length === 0) return;
    await this.prisma.gameParticipant.deleteMany({ where: { userId } });
    const byPost = new Map<string, { post: (typeof rows)[number]['post']; wasJoined: boolean }>();
    for (const r of rows) {
      const cur = byPost.get(r.post.id);
      byPost.set(r.post.id, {
        post: r.post,
        wasJoined: (cur?.wasJoined ?? false) || r.status === 'joined',
      });
    }
    const now = new Date();
    for (const { post, wasJoined } of byPost.values()) {
      if (!wasJoined) continue;
      const started =
        post.date < startOfToday() ||
        (isSameDay(post.date, now) && post.startMinutes <= minutesSinceMidnight(now));
      if (post.status === 'full' && !started) {
        await this.prisma.gamePost.update({
          where: { id: post.id },
          data: { status: 'open' },
        });
      }
      if (post.creatorId !== userId) {
        await this.notifications
          .pushToUser(post.creatorId, {
            title: 'Squad update',
            body: `A player left your ${post.sport} game — their spot is open again.`,
            data: { type: 'game_roster_changed' },
          })
          .catch(() => {});
      }
    }
  }

  /** Delete any game posts the player still hosts (squads notified). */
  async deleteHostedPosts(userId: string) {
    const posts = await this.prisma.gamePost.findMany({
      where: { creatorId: userId },
      select: { id: true, sport: true },
    });
    for (const post of posts) {
      const squad = await this.prisma.gameParticipant.findMany({
        where: { postId: post.id, userId: { not: null } },
        select: { userId: true },
      });
      for (const s of squad) {
        await this.notifications
          .pushToUser(s.userId!, {
            title: 'Game cancelled',
            body: `The ${post.sport} game you were in was removed — the host left Areana.`,
            data: { type: 'game_cancelled' },
          })
          .catch(() => {});
      }
      await this.prisma.gamePost.delete({ where: { id: post.id } });
    }
  }

  async suspendPlayerWithCascade(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.suspended },
    });
    const cancelledCount = await this.cancelFutureBookings(
      userId,
      "because the player's account was suspended",
    );
    await this.exitGames(userId);
    await this.notifications
      .pushToUser(userId, {
        title: 'Account suspended',
        body:
          cancelledCount > 0
            ? `Your Areana account has been suspended and your ${cancelledCount} upcoming booking${cancelledCount === 1 ? ' was' : 's were'} cancelled.`
            : 'Your Areana account has been suspended.',
        data: { type: 'account_suspended' },
      })
      .catch(() => {});
    // Revoke live sessions too, so suspension is immediate, not at the
    // next refresh.
    await this.prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async cancelByOwner(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (!UPCOMING.includes(booking.status)) {
      throw new BadRequestException('Only upcoming bookings can be cancelled');
    }
    // Same guards as the player cancel path: a slot that already
    // started is history, not a cancellation — and a checked-in
    // player is already on the court.
    const now = new Date();
    const started =
      booking.date < startOfToday() ||
      (isSameDay(booking.date, now) && booking.startMinutes <= minutesSinceMidnight(now));
    if (started) throw new BadRequestException('Cannot cancel a slot that already started');
    if (booking.checkedInAt) {
      throw new BadRequestException('This booking is already checked in — it cannot be cancelled');
    }
    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.cancelled },
    });
    await this.rejectPendingReschedules(bookingId);
    await this.cleanupGamePost(bookingId, 'The venue cancelled the booking, so this game is off.');
    await this.notifyWaitlist(booking);
    await this.releasePromo(bookingId);
    return updated;
  }

  /**
   * A booking leaving the active states must never be resurrected by a
   * stale pending reschedule request — reject them all, with a reason,
   * so the owner can no longer accept one.
   */
  async rejectPendingReschedules(bookingId: string, reason = 'Booking is no longer active') {
    await this.prisma.rescheduleRequest.updateMany({
      where: { bookingId, status: 'pending' },
      data: { status: 'rejected', reason, decidedAt: new Date() },
    });
  }

  /**
   * True once the slot's end has passed. endMinutes is minutes since
   * play-day midnight and may exceed 1440 for overnight bookings, so
   * the end day is derived from it instead of assuming the play date.
   */
  slotEnded(b: { date: Date; endMinutes: number }, now = new Date()): boolean {
    const endDay = new Date(b.date);
    endDay.setDate(endDay.getDate() + Math.floor(b.endMinutes / 1440));
    const endMin = b.endMinutes % 1440;
    const today = startOfToday();
    return endDay < today || (isSameDay(endDay, today) && endMin <= minutesSinceMidnight(now));
  }

  private async getPending(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { venue: { select: { name: true } } },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.status !== BookingStatus.pending) {
      throw new BadRequestException('Only pending bookings can be accepted/rejected');
    }
    return booking;
  }

  private fmtWhen(b: { date: Date; startMinutes: number }): string {
    const ds = b.date.toISOString().slice(0, 10);
    const hh = String(Math.floor(b.startMinutes / 60)).padStart(2, '0');
    const mm = String(b.startMinutes % 60).padStart(2, '0');
    return `${ds} ${hh}:${mm}`;
  }
}
