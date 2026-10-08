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

    const [bookings, blocks] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          courtId,
          date,
          status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
        },
        select: { startMinutes: true, endMinutes: true },
      }),
      this.prisma.slotBlock.findMany({
        where: { courtId, date },
        select: { startMinutes: true, endMinutes: true },
      }),
    ]);
    const busy = [...bookings, ...blocks];

    const now = new Date();
    const minBookableAt = new Date(now.getTime() + court.venue.minAdvanceMinutes * 60_000);
    const maxDate = startOfToday();
    maxDate.setDate(maxDate.getDate() + court.venue.maxAdvanceDays);
    const beyondWindow = date > maxDate;

    const slots: SlotDto[] = [];
    for (
      let start = court.openMinutes;
      start + court.slotMinutes <= court.closeMinutes;
      start += court.slotMinutes
    ) {
      const end = start + court.slotMinutes;
      const clash = busy.some((b) => start < b.endMinutes && end > b.startMinutes);

      const slotAt = new Date(date);
      slotAt.setHours(Math.floor(start / 60), start % 60, 0, 0);
      const tooSoon = slotAt < minBookableAt;

      slots.push({
        startMinutes: start,
        endMinutes: end,
        available: !clash && !tooSoon && !beyondWindow,
        price: Number(court.pricePerHour) * (court.slotMinutes / 60),
      });
    }

    return {
      courtId,
      venueId: court.venueId,
      date: dateStr,
      currency: 'PKR',
      slotMinutes: court.slotMinutes,
      slots,
    };
  }
}
