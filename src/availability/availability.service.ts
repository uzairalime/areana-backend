import { Injectable } from '@nestjs/common';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { CourtsService } from '../courts/courts.service';
import {
  isSameDay,
  minutesSinceMidnight,
  parseDateOnly,
  startOfToday,
} from '../common/date.util';

export interface SlotDto {
  startMinutes: number;
  endMinutes: number;
  available: boolean;
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
    const busy = [
      ...bookings,
      ...prevBookings.map((b) => ({
        startMinutes: b.startMinutes - 1440,
        endMinutes: b.endMinutes - 1440,
      })),
      ...nextBookings.map((b) => ({
        startMinutes: b.startMinutes + 1440,
        endMinutes: b.endMinutes + 1440,
      })),
      ...blockedRanges,
    ];

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
        const clash = busy.some((b) => start < b.endMinutes && end > b.startMinutes);

        const slotAt = new Date(date);
        slotAt.setHours(Math.floor(start / 60), start % 60, 0, 0);
        const tooSoon = slotAt < minBookableAt;
        const tooFar = slotAt > maxBookableAt;

        const baseRate = Number(court.pricePerHour);
        const rate = this.courts.rateForSlotPair(priceWindows, baseRate, start);
        slots.push({
          startMinutes: start,
          endMinutes: end,
          available: !clash && !tooSoon && !tooFar,
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
      windows,
      slots,
    };
  }
}
