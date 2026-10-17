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

    const [bookings, windows, blockedRanges, priceWindows] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          courtId,
          date,
          status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
        },
        select: { startMinutes: true, endMinutes: true },
      }),
      this.courts.windowsForDate(court, date),
      this.courts.blockedRangesForDate(courtId, date),
      this.courts.priceWindowsForDate(courtId, date),
    ]);
    const busy = [...bookings, ...blockedRanges];

    const now = new Date();
    const minBookableAt = new Date(now.getTime() + court.venue.minAdvanceMinutes * 60_000);
    const maxDate = startOfToday();
    maxDate.setDate(maxDate.getDate() + court.venue.maxAdvanceDays);
    const beyondWindow = date > maxDate;

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

        const baseRate = Number(court.pricePerHour);
        const rate = this.courts.priceRateForSlot(priceWindows, baseRate, start);
        slots.push({
          startMinutes: start,
          endMinutes: end,
          available: !clash && !tooSoon && !beyondWindow,
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
