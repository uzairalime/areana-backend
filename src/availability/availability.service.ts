import { BadRequestException, Injectable } from '@nestjs/common';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { CourtsService } from '../courts/courts.service';
import {
  isSameDay,
  minutesSinceMidnight,
  parseDateOnly,
  startOfToday,
} from '../common/date.util';

/**
 * Round 5, R5-10: why a slot is (un)available, using exactly these
 * strings — 'booked' (a pending/confirmed booking occupies it),
 * 'past' (slot start already passed), 'too_late' (inside the venue's
 * min-advance window — too soon to book), 'not_open_yet' (beyond the
 * max-advance horizon — the booking window has not opened yet),
 * 'blocked' (an owner one-off/recurring block covers it),
 * 'available'. Precedence: past > too_late > not_open_yet > booked >
 * blocked > available (a slot can be both booked and in the past; the
 * time reason wins, matching what the player must be told first).
 */
export type SlotReason = 'booked' | 'past' | 'too_late' | 'not_open_yet' | 'blocked' | 'available';

export interface SlotDto {
  startMinutes: number;
  endMinutes: number;
  available: boolean;
  reason: SlotReason;
  price: number;
  /** True when a price window priced this slot ABOVE the base rate. */
  peak: boolean;
  /** True when a price window priced this slot BELOW the base rate. */
  deal: boolean;
}

@Injectable()
export class AvailabilityService {
  constructor(
    private prisma: PrismaService,
    private courts: CourtsService,
  ) {}

  /**
   * Builds the day's slots for a court — the server-side source of truth.
   * A slot is bookable only if: inside court hours, aligned to the grid,
   * not overlapping a pending/confirmed booking or owner block,
   * not in the past, and honoring the venue's booking window
   * (min advance notice / max advance days).
   */
  async getAvailability(courtId: string, dateStr: string) {
    const court = await this.courts.getActiveCourt(courtId);
    // Same guard as notifyWaitlist: stepping by a zero/negative slot
    // length below would loop forever (start never advances, or walks
    // backwards) while pushing slots into an unbounded array until the
    // worker is killed. getActiveCourt already rejects such courts;
    // this is the explicit second layer at the loop itself.
    if (court.slotMinutes <= 0) {
      throw new BadRequestException('Court slot length is invalid');
    }
    const date = parseDateOnly(dateStr);

    const prevDay = new Date(date);
    prevDay.setDate(prevDay.getDate() - 1);
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    const [bookings, prevBookings, nextBookings, windows, blockedRanges, priceWindows] =
      await Promise.all([
        this.prisma.booking.findMany({
          where: {
            courtId,
            date,
            status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
          },
          select: { startMinutes: true, endMinutes: true },
        }),
        // Overnight spill, mirroring booking creation's overlap check:
        // yesterday's bookings ending past midnight occupy this
        // morning's early hours, and tomorrow's early bookings occupy
        // this evening's overnight window. Without both, the day view
        // showed spill hours as free while booking them failed (or
        // double-booked) — the blocks already spilled, bookings didn't.
        this.prisma.booking.findMany({
          where: {
            courtId,
            date: prevDay,
            status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
            endMinutes: { gt: 1440 },
          },
          select: { startMinutes: true, endMinutes: true },
        }),
        this.prisma.booking.findMany({
          where: {
            courtId,
            date: nextDay,
            status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
            startMinutes: { lt: 360 },
          },
          select: { startMinutes: true, endMinutes: true },
        }),
        this.courts.windowsForDate(court, date),
        this.courts.blockedRangesForDate(courtId, date),
        this.courts.priceWindowsForDateRange(courtId, date),
      ]);
    // Round 5, R5-10: bookings and blocks are kept separate (the old
    // merged `busy` list could not tell 'booked' from 'blocked').
    const bookedRanges = [
      ...bookings,
      ...prevBookings.map((b) => ({
        startMinutes: b.startMinutes - 1440,
        endMinutes: b.endMinutes - 1440,
      })),
      ...nextBookings.map((b) => ({
        startMinutes: b.startMinutes + 1440,
        endMinutes: b.endMinutes + 1440,
      })),
    ];
    // (blockedRanges is consulted separately below for 'blocked'.)

    const now = new Date();
    const minBookableAt = new Date(now.getTime() + court.venue.minAdvanceMinutes * 60_000);
    // Max-advance is an INSTANT like min-advance, not a calendar date
    // (see bookings.validateWindow): the old date comparison let the
    // horizon vary by ~24h with the time of day. Per-slot now, so a
    // slot exactly at the horizon stays bookable.
    const maxBookableAt = new Date(now.getTime() + court.venue.maxAdvanceDays * 24 * 3600_000);

    // Slots are generated per open window for the day (weekly template
    // or the court's default hours; empty windows = closed that day).
    const slots: SlotDto[] = [];
    for (const w of windows) {
      for (
        let start = w.startMinutes;
        start + court.slotMinutes <= w.endMinutes;
        start += court.slotMinutes
      ) {
        const end = start + court.slotMinutes;
        const booked = bookedRanges.some((b) => start < b.endMinutes && end > b.startMinutes);
        const blocked = blockedRanges.some((b) => start < b.endMinutes && end > b.startMinutes);
        const clash = booked || blocked;

        const slotAt = new Date(date);
        slotAt.setHours(Math.floor(start / 60), start % 60, 0, 0);
        const tooSoon = slotAt < minBookableAt;
        const tooFar = slotAt > maxBookableAt;

        // Round 5, R5-10: reason follows the precedence in SlotReason.
        // 'past' is slot start <= now (a slot starting right now is
        // already unbookable — validateWindow refuses bookingAt <=
        // now, and minAdvance makes tooSoon true anyway for any
        // sane minAdvanceMinutes; past still wins explicitly).
        const reason: SlotReason =
          slotAt <= now
            ? 'past'
            : tooSoon
              ? 'too_late'
              : tooFar
                ? 'not_open_yet'
                : booked
                  ? 'booked'
                  : blocked
                    ? 'blocked'
                    : 'available';
        const baseRate = Number(court.pricePerHour);
        const rate = this.courts.rateForSlotPair(priceWindows, baseRate, start);
        slots.push({
          startMinutes: start,
          endMinutes: end,
          available: !clash && !tooSoon && !tooFar && reason !== 'past',
          reason,
          price: rate * (court.slotMinutes / 60),
          peak: rate > baseRate,
          deal: rate < baseRate,
        });
      }
    }

    return {
      courtId,
      venueId: court.venueId,
      date: dateStr,
      currency: 'PKR',
      slotMinutes: court.slotMinutes,
      // Round 5, R5-10: the venue's min-advance window, alongside the
      // per-slot reasons, so the player web can label 'too_late'
      // slots without a second call. (GET /venues/:id already returns
      // minAdvanceMinutes as a venue column — no change needed there.)
      minAdvanceMinutes: court.venue.minAdvanceMinutes,
      windows,
      slots,
    };
  }
}
