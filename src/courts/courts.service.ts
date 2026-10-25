import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus, Prisma, UserStatus, VenueStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { addMonths, startOfToday } from '../common/date.util';

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

  /**
   * The court's open windows for one date, read through the caller's
   * transaction client — the tx-aware twin of windowsForDate, for
   * checks that must see uncommitted work inside that transaction.
   */
  async windowsForDateInTx(
    tx: Prisma.TransactionClient,
    court: { id: string; openMinutes: number; closeMinutes: number },
    date: Date,
  ): Promise<DayWindow[]> {
    const rows = await tx.courtWeeklyWindow.findMany({
      where: { courtId: court.id, weekday: date.getDay() },
      orderBy: { startMinutes: 'asc' },
      select: { startMinutes: true, endMinutes: true },
    });
    if (rows.length > 0) return rows;
    const any = await tx.courtWeeklyWindow.count({
      where: { courtId: court.id },
    });
    if (any === 0) {
      return [{ startMinutes: court.openMinutes, endMinutes: court.closeMinutes }];
    }
    return []; // template exists, this weekday is closed
  }

  /**
   * Re-validate a slot against the CURRENT windows inside the creation
   * transaction (same messages as the pre-check's validateSlotGrid).
   * The pre-check alone is stale by commit time: an owner shrinking
   * hours — or adding a template that closes the weekday — between
   * pre-check and insert used to strand a booking outside the hours it
   * was sold under. The court row is read fresh inside the tx (the
   * caller holds its row lock), so a concurrent court edit is seen.
   * Blocked ranges are NOT re-checked here: assertNoOverlap already
   * re-checks them in-tx via blockedRangesForDate.
   */
  async assertSlotInTx(
    tx: Prisma.TransactionClient,
    courtId: string,
    date: Date,
    startMinutes: number,
    endMinutes: number,
  ): Promise<void> {
    const court = await tx.court.findUnique({
      where: { id: courtId },
      select: { slotMinutes: true, openMinutes: true, closeMinutes: true },
    });
    if (!court) throw new NotFoundException('Court not found');
    const windows = await this.windowsForDateInTx(
      tx,
      { id: courtId, openMinutes: court.openMinutes, closeMinutes: court.closeMinutes },
      date,
    );
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

  /** Price windows (peak/off-peak rates) applying on a given date. */
  async priceWindowsForDate(courtId: string, date: Date, tx?: Prisma.TransactionClient) {
    const db = tx ?? this.prisma;
    // Round 5, D5-B9 (lookup half): overlapping windows can still be
    // created concurrently (creation serialisation lives in the
    // price-window create path), so the lookup MUST be deterministic
    // — an unordered findMany priced an overlapped slot by whichever
    // window Postgres returned first. Earliest-created wins, with id
    // as the tie-break: the same overlap always prices the same way.
    const rows = await db.courtPriceWindow.findMany({
      where: { courtId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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
   * Price windows for a date AND the next date, for overnight slots.
   * Precedence for a post-midnight hour (startMinutes >= 1440), see
   * rateForSlotPair: the next day's morning window first, then the
   * evening window covering the spill hour, then the base rate.
   */
  async priceWindowsForDateRange(courtId: string, date: Date, tx?: Prisma.TransactionClient) {
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    const [day, next] = await Promise.all([
      this.priceWindowsForDate(courtId, date, tx),
      this.priceWindowsForDate(courtId, nextDay, tx),
    ]);
    return { day, next };
  }

  /**
   * The Rs/hour rate for a slot starting at `startMinutes`: the price
   * window covering the slot start, else the court's base rate.
   * Windows arrive in createdAt order (see priceWindowsForDate), so
   * on an overlap the earliest-created window wins deterministically.
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
   * next day's windows (with minutes shifted back into that day) —
   * UNLESS no morning window covers the hour, in which case the
   * evening window covering the spill hour prices it (Round 4, O-S20:
   * an evening peak window ending past midnight used to price its
   * post-midnight hours at the next day's BASE rate, because the
   * morning lookup found nothing and never consulted the evening
   * window). Daytime slots price from the date's own windows.
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
      const morning = windows.next.find(
        (x) => startMinutes - 1440 >= x.startMinutes && startMinutes - 1440 < x.endMinutes,
      );
      if (morning) return Number(morning.pricePerHour);
      const evening = windows.day.find(
        (x) => startMinutes >= x.startMinutes && startMinutes < x.endMinutes,
      );
      if (evening) return Number(evening.pricePerHour);
      return baseRate;
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
    const prevDay = new Date(date);
    prevDay.setDate(prevDay.getDate() - 1);
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    const [oneOff, recurring, nextBlocks, prevBlocks] = await Promise.all([
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
      // Round 5, O5-S10 (= R5-S11): the MIRROR spill — a previous-day
      // one-off block running past midnight (e.g. Fri 23:00–01:00)
      // physically covers this date's early hours, yet was never
      // reported here, so Sat availability showed 00:00–01:00 free
      // and a Sat 00:00–01:00 booking sold into blocked time.
      // Shifted −1440 and clamped at 0 (the tail starts at midnight
      // on this date even when the block started the evening before).
      // Recurring blocks cannot cross midnight, so this is one-off
      // blocks only; template courts are protected separately by
      // the template spill check.
      db.slotBlock.findMany({
        where: { courtId, date: prevDay, endMinutes: { gt: 1440 } },
        select: { startMinutes: true, endMinutes: true },
      }),
    ]);
    const spill = nextBlocks.map((b) => ({
      startMinutes: b.startMinutes + 1440,
      endMinutes: b.endMinutes + 1440,
    }));
    const prevSpill = prevBlocks.map((b) => ({
      startMinutes: Math.max(0, b.startMinutes - 1440),
      endMinutes: b.endMinutes - 1440,
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
    return [...oneOff, ...rec, ...spill, ...recSpill, ...prevSpill];
  }

  /**
   * Shared shrink guard (Round 5, O5-S5): the ONE implementation both
   * the owner and admin updateCourt paths use. Counts upcoming
   * pending + confirmed bookings that fall outside the EFFECTIVE
   * windows for their own date — template if present, else the given
   * headline hours — not the headline alone. The admin path used to
   * count confirmed only against raw headline hours, so it stranded
   * pending bookings and template-governed bookings the owner path
   * refused; the two paths now agree on whether an edit is legal.
   */
  /**
   * Round 5, R5-1: the stranded bookings themselves (not just their
   * count), in the exact shape the shrink-guard error carries:
   * [{ id, date (YYYY-MM-DD), startMinutes, endMinutes }], ordered by
   * date then start, so the panel can show the list before the owner
   * acknowledges and retries. `date` is a YYYY-MM-DD string (same
   * convention as OwnerService.conflictView) — never a Date object —
   * so the error payload serializes identically everywhere.
   */
  async listStrandedBookings(
    courtId: string,
    headline: { openMinutes: number; closeMinutes: number },
  ): Promise<{ id: string; date: string; startMinutes: number; endMinutes: number }[]> {
    const upcoming = await this.prisma.booking.findMany({
      where: {
        courtId,
        date: { gte: startOfToday() },
        status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
      },
      select: { id: true, date: true, startMinutes: true, endMinutes: true },
      orderBy: [{ date: 'asc' }, { startMinutes: 'asc' }],
    });
    const stranded: { id: string; date: string; startMinutes: number; endMinutes: number }[] = [];
    for (const b of upcoming) {
      const windows = await this.windowsForDate(
        { id: courtId, openMinutes: headline.openMinutes, closeMinutes: headline.closeMinutes },
        b.date,
      );
      if (
        !windows.some(
          (w) => b.startMinutes >= w.startMinutes && b.endMinutes <= w.endMinutes,
        )
      ) {
        stranded.push({
          id: b.id,
          date: toYmd(b.date),
          startMinutes: b.startMinutes,
          endMinutes: b.endMinutes,
        });
      }
    }
    return stranded;
  }

  async countStrandedBookings(
    courtId: string,
    headline: { openMinutes: number; closeMinutes: number },
  ): Promise<number> {
    return (await this.listStrandedBookings(courtId, headline)).length;
  }

  /**
   * Live overdue-ness, mirroring PlansService billingSummary: the
   * materialized billingPaused flag only flips on the nightly sweep,
   * so between the grace end and 00:30 a venue whose fee is overdue
   * would otherwise keep taking bookings. Computed here because
   * injecting PlansService would cycle modules (Plans → Bookings →
   * Courts). Keep this in step with plans.context/billingSummary.
   * When the caller passes its transaction client (Round 4, R-S7),
   * the plan and grace-days reads go through it, so a plan/grace
   * change committed inside the caller's transaction is seen —
   * the gate is no longer best-effort against a stale snapshot.
   */
  private async isBillingOverdue(
    venue: {
      billingStartAt: Date | null;
      billingPaidUntil: Date | null;
      freeUntilOverride: Date | null;
      billingPeriodStart: Date | null;
      billingPeriodEnd: Date | null;
      billingPeriodPrice?: unknown;
      planId: string | null;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (!venue.billingStartAt) return false;
    const db = tx ?? this.prisma;
    const plan = venue.planId
      ? await db.plan.findUnique({ where: { id: venue.planId } })
      : await db.plan.findFirst({ where: { isDefault: true } });
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
    const setting = await db.setting.findUnique({
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
    // Legacy courts with slotMinutes <= 0 are no longer creatable,
    // but stored ones must not sell: a negative slot length mints free
    // bookings with end < start (the grid/overlap checks both pass on
    // inverted ranges), and a zero length hangs every stepping loop.
    // Reject at this choke point, so booking creation, availability,
    // walk-ins, and reschedule accept all refuse the court instead.
    if (court.slotMinutes <= 0) {
      throw new BadRequestException('Court slot length is invalid');
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
    if (!court || (await this.isBillingOverdue(court.venue, tx))) {
      throw new NotFoundException('Court not found');
    }
    // Same legacy slotMinutes guard as getActiveCourt, re-run inside
    // the transaction so a court edited mid-flight cannot sell.
    if (court.slotMinutes <= 0) {
      throw new BadRequestException('Court slot length is invalid');
    }
  }

  /**
   * Upcoming bookings whose start no longer sits on the grid implied
   * by a NEW slot length (Round 4, O-S5): the booking must sit inside
   * one effective window for its date (template if present, else the
   * given headline hours) and align to that window's start on the new
   * grid. Bookings outside every window are NOT misaligned — they are
   * the shrink guard's (O-S4) problem, not the grid's.
   */
  async findMisalignedBookings(
    courtId: string,
    newSlotMinutes: number,
    headline: { openMinutes: number; closeMinutes: number },
  ) {
    const rows = await this.prisma.booking.findMany({
      where: {
        courtId,
        date: { gte: startOfToday() },
        status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
      },
      include: { user: { select: { name: true } } },
      orderBy: [{ date: 'asc' }, { startMinutes: 'asc' }],
    });
    const misaligned = [];
    for (const b of rows) {
      const windows = await this.windowsForDate(
        { id: courtId, openMinutes: headline.openMinutes, closeMinutes: headline.closeMinutes },
        b.date,
      );
      const w = windows.find(
        (x) => b.startMinutes >= x.startMinutes && b.endMinutes <= x.endMinutes,
      );
      if (!w) continue;
      if ((b.startMinutes - w.startMinutes) % newSlotMinutes !== 0) {
        misaligned.push(b);
      }
    }
    return misaligned;
  }
}
