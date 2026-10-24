import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserStatus, VenueStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { addMonths } from '../common/date.util';

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
   * Price windows for a date AND the next date, for overnight slots:
   * post-midnight hours of an overnight window (startMinutes >= 1440)
   * are priced by the MORNING's weekday windows, never the evening's —
   * a Sat 00:00–02:00 peak window must price Fri night's 00:00–02:00
   * slots, not Fri's evening windows.
   */
  async priceWindowsForDateRange(courtId: string, date: Date) {
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    const [day, next] = await Promise.all([
      this.priceWindowsForDate(courtId, date),
      this.priceWindowsForDate(courtId, nextDay),
    ]);
    return { day, next };
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

  /**
   * Overnight-aware slot rate: slots at/after midnight price from the
   * next day's windows (with minutes shifted back into that day),
   * daytime slots from the date's own windows.
   */
  rateForSlotPair(
    windows: {
      day: { startMinutes: number; endMinutes: number; pricePerHour: unknown }[];
      next: { startMinutes: number; endMinutes: number; pricePerHour: unknown }[];
    },
    baseRate: number,
    startMinutes: number,
  ): number {
    if (startMinutes >= 1440) {
      return this.priceRateForSlot(windows.next, baseRate, startMinutes - 1440);
    }
    return this.priceRateForSlot(windows.day, baseRate, startMinutes);
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
  async blockedRangesForDate(
    courtId: string,
    date: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<DayWindow[]> {
    // Pass the caller's transaction client when the check must see
    // uncommitted work inside that transaction (booking creation
    // re-checks overlap under the court row lock).
    const db = tx ?? this.prisma;
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    const [oneOff, recurring, nextBlocks] = await Promise.all([
      db.slotBlock.findMany({
        where: { courtId, date },
        select: { startMinutes: true, endMinutes: true },
      }),
      db.recurringBlock.findMany({ where: { courtId } }),
      // Overnight spill: an early-morning block on the NEXT date (e.g.
      // Sat 01:00–02:00) also blocks this date's overnight window
      // (Fri 18:00–02:00), where those hours are minutes 1500–1560.
      db.slotBlock.findMany({
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
    // Recurring spill, mirroring the one-off spill above: a recurring
    // early-morning block on the NEXT date (e.g. every Sat 01:00–02:00)
    // also blocks this date's overnight window. Without it the blocked
    // time was sold — the one-off spill existed but recurring blocks
    // never spilled.
    const nextDayStr = toYmd(nextDay);
    const nextWeekday = nextDay.getDay();
    const recSpill = recurring
      .filter(
        (r) =>
          r.weekdays.includes(nextWeekday) &&
          r.startMinutes < 360 &&
          (!r.startsOn || toYmd(r.startsOn) <= nextDayStr) &&
          (!r.endsOn || toYmd(r.endsOn) >= nextDayStr),
      )
      .map((r) => ({
        startMinutes: r.startMinutes + 1440,
        endMinutes: r.endMinutes + 1440,
      }));
    return [...oneOff, ...rec, ...spill, ...recSpill];
  }

  /**
   * Live overdue-ness, mirroring PlansService billingSummary: the
   * materialized billingPaused flag only flips on the nightly sweep,
   * so between the grace end and 00:30 a venue whose fee is overdue
   * would otherwise keep taking bookings. Computed here because
   * injecting PlansService would cycle modules (Plans → Bookings →
   * Courts). Keep this in step with plans.context/billingSummary.
   */
  private async isBillingOverdue(venue: {
    billingStartAt: Date | null;
    billingPaidUntil: Date | null;
    freeUntilOverride: Date | null;
    billingPeriodStart: Date | null;
    billingPeriodEnd: Date | null;
    billingPeriodPrice?: unknown;
    planId: string | null;
  }): Promise<boolean> {
    if (!venue.billingStartAt) return false;
    const plan = venue.planId
      ? await this.prisma.plan.findUnique({ where: { id: venue.planId } })
      : await this.prisma.plan.findFirst({ where: { isDefault: true } });
    if (!plan) return false;
    const freeUntil =
      venue.freeUntilOverride ?? addMonths(venue.billingStartAt, plan.freeMonths);
    const now = new Date();
    if (now < freeUntil) return false;
    if (venue.billingPaidUntil && venue.billingPaidUntil > now) return false;
    // Mirrors plans.context()'s freeze rule: periods advance only while
    // PAID, so an unpaid period keeps the venue overdue instead of
    // silently walking the due date forward past the arrears.
    let periodStart: Date;
    let periodEnd: Date;
    if (venue.billingPeriodStart && venue.billingPeriodEnd) {
      periodStart = venue.billingPeriodStart;
      periodEnd = venue.billingPeriodEnd;
      while (venue.billingPaidUntil && venue.billingPaidUntil >= periodEnd) {
        periodStart = periodEnd;
        periodEnd = addMonths(periodStart, 12);
      }
    } else {
      periodStart = freeUntil;
      periodEnd = addMonths(freeUntil, 12);
      while (venue.billingPaidUntil && venue.billingPaidUntil >= periodEnd) {
        periodStart = periodEnd;
        periodEnd = addMonths(periodStart, 12);
      }
      while (now < periodStart && periodStart > freeUntil) {
        periodEnd = periodStart;
        periodStart = addMonths(periodStart, -12);
      }
    }
    // Zero-price periods are never overdue (mirror of billingSummary):
    // a Rs 0 period is not a debt, so it must not block bookings. The
    // frozen price governs while the walk is still inside the frozen
    // period, else the plan price — same rule as plans.context().
    const frozenPrice =
      venue.billingPeriodStart &&
      venue.billingPeriodEnd &&
      periodStart.getTime() === venue.billingPeriodStart.getTime() &&
      venue.billingPeriodPrice != null
        ? Number(venue.billingPeriodPrice)
        : null;
    const price = frozenPrice ?? plan.priceYearly;
    if (price === 0) return false;
    const setting = await this.prisma.setting.findUnique({
      where: { key: 'billingGraceDays' },
    });
    const grace = setting ? parseInt(setting.value, 10) || 14 : 14;
    return now > new Date(periodStart.getTime() + grace * 24 * 3600_000);
  }

  /** The full live-venue predicate shared by listByVenue and getActiveCourt. */
  private venuePredicate() {
    return {
      status: VenueStatus.approved,
      archivedAt: null,
      billingPaused: false,
      moderationStatus: 'none',
      owner: { status: UserStatus.active },
    } as const;
  }

  // Public: courts of one approved venue.
  async listByVenue(venueId: string) {
    const venue = await this.prisma.venue.findFirst({
      where: { id: venueId, ...this.venuePredicate() },
      select: {
        id: true,
        billingStartAt: true,
        billingPaidUntil: true,
        freeUntilOverride: true,
        billingPeriodStart: true,
        billingPeriodEnd: true,
        billingPeriodPrice: true,
        planId: true,
      },
    });
    if (!venue || (await this.isBillingOverdue(venue))) {
      throw new NotFoundException('Venue not found');
    }
    return this.prisma.court.findMany({
      where: { venueId, isActive: true, status: 'approved' },
      orderBy: { pricePerHour: 'asc' },
    });
  }

  async getActiveCourt(courtId: string) {
    const court = await this.prisma.court.findFirst({
      where: {
        id: courtId,
        isActive: true,
        status: 'approved',
        venue: this.venuePredicate(),
      },
      include: { venue: true },
    });
    if (!court || (await this.isBillingOverdue(court.venue))) {
      throw new NotFoundException('Court not found');
    }
    return court;
  }

  /**
   * The getActiveCourt predicate re-run inside the caller's transaction
   * (booking creation re-verifies under the venue + court row locks).
   * Without it, a court deleted, deactivated, re-queued, or a venue
   * archived/suspended between the pre-check and the insert would take
   * a booking it must not take — or FK-fail on a deleted court.
   */
  async assertBookableInTx(tx: Prisma.TransactionClient, courtId: string): Promise<void> {
    const court = await tx.court.findFirst({
      where: {
        id: courtId,
        isActive: true,
        status: 'approved',
        venue: this.venuePredicate(),
      },
      include: { venue: true },
    });
    if (!court || (await this.isBillingOverdue(court.venue))) {
      throw new NotFoundException('Court not found');
    }
  }
}
