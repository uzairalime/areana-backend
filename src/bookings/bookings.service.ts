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

    this.validateSlotGrid(court, startMinutes, slotCount);
    const endMinutes = startMinutes + court.slotMinutes * slotCount;
    if (!input.skipWindowCheck) {
      this.validateWindow(court, date, startMinutes);
    }

    await this.assertNoOverlap(court.id, date, startMinutes, endMinutes);

    const gross = Number(court.pricePerHour) * ((court.slotMinutes * slotCount) / 60);
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

  private validateSlotGrid(court: any, startMinutes: number, slotCount: number) {
    if (
      startMinutes < court.openMinutes ||
      startMinutes + court.slotMinutes * slotCount > court.closeMinutes ||
      (startMinutes - court.openMinutes) % court.slotMinutes !== 0
    ) {
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

    const blocked = await this.prisma.slotBlock.findFirst({
      where: {
        courtId,
        date,
        startMinutes: { lt: endMinutes },
        endMinutes: { gt: startMinutes },
      },
      select: { id: true },
    });
    if (blocked) throw new ConflictException('Slot is blocked by the arena');
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
    const res = await this.prisma.booking.updateMany({
      where: {
        recurrenceId,
        userId,
        status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
        date: { gte: startOfToday() },
      },
      data: { status: BookingStatus.cancelled },
    });
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
        venue: { select: { name: true, address: true, city: true } },
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

    return this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.cancelled },
    });
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
        venue: { select: { name: true, address: true, city: true } },
        participants: { select: { name: true, joinedAt: true } },
      },
    });
    if (!booking || booking.status === BookingStatus.cancelled) {
      throw new NotFoundException('Booking link is invalid or expired');
    }
    const { checkInCode: _c, ...safe } = booking as any;
    return safe;
  }

  async joinShared(shareCode: string, dto: JoinSharedDto, userId?: string) {
    const booking = await this.prisma.booking.findUnique({ where: { shareCode } });
    if (!booking || booking.status === BookingStatus.cancelled) {
      throw new NotFoundException('Booking link is invalid or expired');
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
    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.confirmed },
    });
    if (booking.userId) {
      await this.notifications.notifyPlayerDecision(booking.userId, true, booking.venue.name, this.fmtWhen(booking)).catch(() => {});
    }
    return updated;
  }

  async rejectBooking(bookingId: string, reason?: string) {
    const booking = await this.getPending(bookingId);
    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.cancelled },
    });
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
    return this.prisma.booking.update({
      where: { id: bookingId },
      data: { checkedInAt: new Date() },
    });
  }

  async markNoShow(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.no_show },
    });
    if (booking.userId) {
      const user = await this.prisma.user.update({
        where: { id: booking.userId },
        data: { noShowCount: { increment: 1 } },
      });
      const limit = parseInt((await this.prisma.setting.findUnique({ where: { key: 'noShowStrikeLimit' } }))?.value ?? '3', 10);
      if (user.noShowCount >= limit) {
        await this.prisma.user.update({ where: { id: booking.userId }, data: { status: UserStatus.suspended } });
      }
    }
    return updated;
  }

  async cancelByOwner(bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (!UPCOMING.includes(booking.status)) {
      throw new BadRequestException('Only upcoming bookings can be cancelled');
    }
    return this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.cancelled },
    });
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
