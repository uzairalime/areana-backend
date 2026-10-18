import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, Prisma, UserStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
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
      this.validateWindow(court, date, startMinutes);
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
    let discount = 0;
    let promo: { id: string } | null = null;
    if (input.promoCode && input.userId) {
      const res = await this.promos.validatePromo(input.promoCode, input.userId, gross);
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
          totalPrice: gross - discount,
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

  private validateWindow(court: any, date: Date, startMinutes: number) {
    const now = new Date();
    const bookingAt = new Date(date);
    bookingAt.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);

    const minAt = new Date(now.getTime() + court.venue.minAdvanceMinutes * 60_000);
    if (bookingAt < minAt) {
      throw new BadRequestException(
        `Bookings need at least ${court.venue.minAdvanceMinutes} minutes notice`,
      );
    }
    const maxDate = startOfToday();
    maxDate.setDate(maxDate.getDate() + court.venue.maxAdvanceDays);
    if (date > maxDate) {
      throw new BadRequestException(`Bookings open only ${court.venue.maxAdvanceDays} days ahead`);
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
        });
        created.push(b);
      } catch (e: any) {
        skipped.push({ date: ds, reason: e.message ?? 'Unavailable' });
      }
    }
    return { recurrenceId, created, skipped };
  }

  async cancelRecurringSeries(userId: string, recurrenceId: string) {
    const affected = await this.prisma.booking.findMany({
      where: {
        recurrenceId,
        userId,
        status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
        date: { gte: startOfToday() },
      },
      select: { id: true },
    });
    const res = await this.prisma.booking.updateMany({
      where: { id: { in: affected.map((b) => b.id) } },
      data: { status: BookingStatus.cancelled },
    });
    for (const b of affected) {
      await this.cleanupGamePost(b.id, 'The host cancelled their booking, so this game is off.');
      const full = await this.prisma.booking.findUnique({
        where: { id: b.id },
        select: { courtId: true, date: true, startMinutes: true },
      });
      if (full) await this.notifyWaitlist(full.courtId, full.date, full.startMinutes);
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

    return this.prisma.booking.findMany({
      where,
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
            status: true,
            _count: { select: { participants: true } },
          },
        },
        _count: { select: { participants: true } },
      },
      orderBy: [{ date: 'asc' }, { startMinutes: 'asc' }],
    });
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
    await this.cleanupGamePost(bookingId, 'The host cancelled their booking, so this game is off.');
    await this.notifyWaitlist(booking.courtId, booking.date, booking.startMinutes);
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
  async notifyWaitlist(courtId: string, date: Date, startMinutes: number) {
    const entries = await this.prisma.slotWaitlist.findMany({
      where: { courtId, date, startMinutes, notifiedAt: null },
    });
    if (entries.length === 0) return;
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: { venue: { select: { name: true } } },
    });
    const hh = String(Math.floor(startMinutes / 60) % 24).padStart(2, '0');
    const mm = String(startMinutes % 60).padStart(2, '0');
    for (const e of entries) {
      await this.notifications
        .pushToUser(e.userId, {
          title: 'A slot just opened up',
          body: `${court?.venue.name ?? 'A venue'} · ${court?.name ?? 'Court'} on ${date.toISOString().slice(0, 10)} at ${hh}:${mm} is free again — grab it before someone else does.`,
          data: { type: 'slot_opened' },
        })
        .catch(() => {});
    }
    await this.prisma.slotWaitlist.updateMany({
      where: { id: { in: entries.map((e) => e.id) } },
      data: { notifiedAt: new Date() },
    });
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
        skipped.push({ id: b.id, reason: 'Slot no longer available' });
      }
    }
    return { accepted, skipped };
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
    return booking;
  }

  async checkIn(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
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
    if (booking.userId) {
      const user = await this.prisma.user.update({
        where: { id: booking.userId },
        data: { noShowCount: { increment: 1 } },
      });
      const limit = parseInt((await this.prisma.setting.findUnique({ where: { key: 'noShowStrikeLimit' } }))?.value ?? '3', 10);
      if (user.noShowCount >= limit && user.status === UserStatus.active) {
        await this.suspendPlayerWithCascade(booking.userId);
      }
    }
    return updated;
  }

  /**
   * Suspends a player and unwinds their future: upcoming bookings are
   * cancelled, the player is told once, and each affected venue owner
   * gets an email. (Owner suspensions deliberately do NOT use this —
   * their bookings stand and venues pause; see round-3 policy.)
   */
  async suspendPlayerWithCascade(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.suspended },
    });
    const today = startOfToday();
    const future = await this.prisma.booking.findMany({
      where: {
        userId,
        date: { gte: today },
        status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
      },
      include: {
        venue: {
          select: { name: true, owner: { select: { email: true } } },
        },
      },
    });
    for (const b of future) {
      await this.prisma.booking.update({
        where: { id: b.id },
        data: { status: BookingStatus.cancelled },
      });
      await this.cleanupGamePost(b.id, "The host's account was suspended, so this game is off.");
      const fullB = await this.prisma.booking.findUnique({
        where: { id: b.id },
        select: { courtId: true, date: true, startMinutes: true },
      });
      if (fullB) await this.notifyWaitlist(fullB.courtId, fullB.date, fullB.startMinutes);
      if (b.venue.owner?.email) {
        await this.notifications
          .notifyOwnerNewBooking(
            b.venue.owner.email,
            b.venue.name,
            `A booking on ${b.date.toISOString().slice(0, 10)} was cancelled because the player's account was suspended.`,
          )
          .catch(() => {});
      }
    }
    await this.notifications
      .pushToUser(userId, {
        title: 'Account suspended',
        body:
          future.length > 0
            ? `Your Areana account has been suspended and your ${future.length} upcoming booking${future.length === 1 ? ' was' : 's were'} cancelled.`
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
    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.cancelled },
    });
    await this.cleanupGamePost(bookingId, 'The venue cancelled the booking, so this game is off.');
    await this.notifyWaitlist(booking.courtId, booking.date, booking.startMinutes);
    return updated;
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
