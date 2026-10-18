import { Injectable, NotFoundException } from '@nestjs/common';
import { UserStatus, VenueStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';

export interface DayWindow {
  startMinutes: number;
  endMinutes: number;
}

/** Local YYYY-MM-DD for a Date (server TZ is Asia/Karachi). */
export function toYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

@Injectable()
export class CourtsService {
  constructor(private prisma: PrismaService) {}

  /**
   * The court's open windows for one date. If the court has a weekly
   * template (any CourtWeeklyWindow rows), the template governs: the
   * weekday's rows are the windows (multiple rows = split shifts), and a
   * weekday with no rows means the court is closed that day. With no
   * template at all, fall back to the court's daily open/close minutes.
   */
  async windowsForDate(
    court: { id: string; openMinutes: number; closeMinutes: number },
    date: Date,
  ): Promise<DayWindow[]> {
    const rows = await this.prisma.courtWeeklyWindow.findMany({
      where: { courtId: court.id, weekday: date.getDay() },
      orderBy: { startMinutes: 'asc' },
      select: { startMinutes: true, endMinutes: true },
    });
    if (rows.length > 0) return rows;
    const any = await this.prisma.courtWeeklyWindow.count({
      where: { courtId: court.id },
    });
    if (any === 0) {
      return [{ startMinutes: court.openMinutes, endMinutes: court.closeMinutes }];
    }
    return []; // template exists, this weekday is closed
  }

  /** Price windows (peak/off-peak rates) applying on a given date. */
  async priceWindowsForDate(courtId: string, date: Date) {
    const rows = await this.prisma.courtPriceWindow.findMany({
      where: { courtId },
    });
    const weekday = date.getDay();
    const dayStr = toYmd(date);
    return rows.filter(
      (r) =>
        r.weekdays.includes(weekday) &&
        (!r.startsOn || toYmd(r.startsOn) <= dayStr) &&
        (!r.endsOn || toYmd(r.endsOn) >= dayStr),
    );
  }

  /**
   * The Rs/hour rate for a slot starting at `startMinutes`: the price
   * window covering the slot start, else the court's base rate.
   */
  priceRateForSlot(
    windows: { startMinutes: number; endMinutes: number; pricePerHour: unknown }[],
    baseRate: number,
    startMinutes: number,
  ): number {
    const w = windows.find(
      (x) => startMinutes >= x.startMinutes && startMinutes < x.endMinutes,
    );
    return w ? Number(w.pricePerHour) : baseRate;
  }

  /** Whether the court has any weekly-hours template rows. */
  async hasWeeklyTemplate(courtId: string): Promise<boolean> {
    const n = await this.prisma.courtWeeklyWindow.count({ where: { courtId } });
    return n > 0;
  }

  /**
   * All blocked ranges for a court on a date: one-off SlotBlocks plus
   * RecurringBlocks whose weekday matches and whose optional date range
   * covers the date.
   */
  async blockedRangesForDate(courtId: string, date: Date): Promise<DayWindow[]> {
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    const [oneOff, recurring, nextBlocks] = await Promise.all([
      this.prisma.slotBlock.findMany({
        where: { courtId, date },
        select: { startMinutes: true, endMinutes: true },
      }),
      this.prisma.recurringBlock.findMany({ where: { courtId } }),
      // Overnight spill: an early-morning block on the NEXT date (e.g.
      // Sat 01:00–02:00) also blocks this date's overnight window
      // (Fri 18:00–02:00), where those hours are minutes 1500–1560.
      this.prisma.slotBlock.findMany({
        where: { courtId, date: nextDay, startMinutes: { lt: 360 } },
        select: { startMinutes: true, endMinutes: true },
      }),
    ]);
    const spill = nextBlocks.map((b) => ({
      startMinutes: b.startMinutes + 1440,
      endMinutes: b.endMinutes + 1440,
    }));
    const weekday = date.getDay();
    const dayStr = toYmd(date);
    const rec = recurring
      .filter(
        (r) =>
          r.weekdays.includes(weekday) &&
          (!r.startsOn || toYmd(r.startsOn) <= dayStr) &&
          (!r.endsOn || toYmd(r.endsOn) >= dayStr),
      )
      .map((r) => ({ startMinutes: r.startMinutes, endMinutes: r.endMinutes }));
    return [...oneOff, ...rec, ...spill];
  }

  // Public: courts of one approved venue.
  async listByVenue(venueId: string) {
    const venue = await this.prisma.venue.findFirst({
      where: { id: venueId, status: VenueStatus.approved },
      select: { id: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    return this.prisma.court.findMany({
      where: { venueId, isActive: true },
      orderBy: { pricePerHour: 'asc' },
    });
  }

  async getActiveCourt(courtId: string) {
    const court = await this.prisma.court.findFirst({
      where: {
        id: courtId,
        isActive: true,
        venue: { status: VenueStatus.approved, owner: { status: UserStatus.active } },
      },
      include: { venue: true },
    });
    if (!court) throw new NotFoundException('Court not found');
    return court;
  }
}
