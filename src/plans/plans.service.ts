import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Venue } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { addMonths } from '../common/date.util';
import { NotificationsService } from '../notifications/notifications.service';
import { BookingsService } from '../bookings/bookings.service';

const PAYMENT_METHODS = ['bank', 'raast', 'cash', 'other'];

/**
 * Transaction-scoped advisory lock key serializing plan writes
 * (create/update/delete). Two concurrent plan writes used to lose each
 * other — lost free months, two coexisting defaults with a
 * nondeterministic findFirst. pg_advisory_xact_lock is released at
 * transaction end, so every plan write takes it first.
 */
const PLAN_WRITE_LOCK = 727001;

/**
 * Subscription plans + venue billing.
 *
 * Business model (Oct 2026): venues pay a YEARLY flat fee per plan
 * (Basic / Normal / Premium), the first `freeMonths` are free, and the
 * super admin can adjust every plan — or build a specialized custom
 * plan for one specific arena. Commission stays a settings lever
 * (default 0%) for the later prepaid era; it is NOT the launch model.
 *
 * Billing clock: starts when a venue is first approved. Free until
 * anchor + freeMonths (or a per-venue override), then yearly periods.
 * A period that stays unpaid past the grace window pauses the venue on
 * public surfaces (billingPaused), like a suspended owner's venue.
 */
export const PLAN_FEATURES: { key: string; label: string; blurb: string }[] = [
  { key: 'peak_pricing', label: 'Peak & off-peak pricing', blurb: 'Per-court price windows for busy and quiet hours' },
  { key: 'advanced_availability', label: 'Recurring blocks & split shifts', blurb: 'Weekly split shifts, recurring blocks and breaks' },
  { key: 'staff_accounts', label: 'Staff logins', blurb: 'Manager/staff accounts for the venue' },
  { key: 'customers_insight', label: 'Customers & player history', blurb: 'Customer list with booking history and strikes' },
  { key: 'featured_placement', label: 'Featured placement', blurb: 'Eligible for featured spots and banner slots' },
];

export type BillingStatus = 'none' | 'trial' | 'active' | 'due' | 'overdue';

export interface BillingSummary {
  status: BillingStatus;
  planId: string | null;
  planName: string | null;
  priceYearly: number | null;
  freeUntil: string | null;
  nextDueAt: string | null;
  amountDue: number;
  paidUntil: string | null;
  billingPaused: boolean;
  /** When the grace window closes (status due/overdue); null otherwise. */
  graceEndsAt: string | null;
}

// Shared month arithmetic lives in common/date.util — plans billing
// and the courts/booking-gate path must agree to the day, and separate
// copies once diverged by ~10.5h on month-end approvals.

@Injectable()
export class PlansService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private bookings: BookingsService,
  ) {}

  // ------------------------------------------------------------------ plans
  async listPlans() {
    const plans = await this.prisma.plan.findMany({
      orderBy: [{ isCustom: 'asc' }, { sortOrder: 'asc' }, { priceYearly: 'asc' }],
      include: { _count: { select: { venues: true } } },
    });
    return plans.map((p) => ({ ...p, features: this.asKeys(p.features) }));
  }

  async createPlan(dto: {
    name: string;
    priceYearly: number;
    freeMonths?: number;
    features?: string[];
    maxVenues?: number | null;
    maxCourts?: number | null;
    maxStaff?: number | null;
    isDefault?: boolean;
    isCustom?: boolean;
  }) {
    this.assertFeatures(dto.features ?? []);
    const plan = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${PLAN_WRITE_LOCK})`;
      // The first plan must be the default: with no default, venues
      // approve with billing running but no plan and no gates. An
      // explicit isDefault=false is overridden only when no default
      // exists yet — afterwards it is honored.
      const existingDefault = await tx.plan.count({ where: { isDefault: true } });
      const makeDefault = (dto.isDefault ?? false) || existingDefault === 0;
      if (makeDefault) {
        await tx.plan.updateMany({ data: { isDefault: false } });
      }
      // A maxVenues of 0 locks out every new owner (0 venues >= 0
      // limit blocks the first venue) — 0 is not a meaningful cap
      // here, so it floors to 1. (maxStaff 0 stays valid: Basic's
      // "no staff" is a real tier, unlike a venue cap of zero.)
      const maxVenues = dto.maxVenues === 0 ? 1 : (dto.maxVenues ?? null);
      return tx.plan.create({
        data: {
          name: dto.name.trim(),
          priceYearly: Math.round(dto.priceYearly),
          freeMonths: dto.freeMonths ?? 3,
          features: dto.features ?? [],
          maxVenues,
          maxCourts: dto.maxCourts ?? null,
          maxStaff: dto.maxStaff ?? null,
          isDefault: makeDefault,
          isCustom: dto.isCustom ?? false,
        },
      });
    });
    return { ...plan, features: this.asKeys(plan.features) };
  }

  async updatePlan(
    id: string,
    dto: Partial<{
      name: string;
      priceYearly: number;
      freeMonths: number;
      features: string[];
      maxVenues: number | null;
      maxCourts: number | null;
      maxStaff: number | null;
      isDefault: boolean;
    }>,
  ) {
    const existing = await this.prisma.plan.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Plan not found');
    if (dto.features) this.assertFeatures(dto.features);
    const plan = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${PLAN_WRITE_LOCK})`;
      // The platform must never be left with zero default plans: venues
      // without their own plan would silently stop being billed or paused.
      // The guard runs inside the locked transaction — two concurrent
      // updates used to both pass the outside read and leave two
      // defaults (or none) behind.
      if (dto.isDefault === false && existing.isDefault) {
        const others = await tx.plan.count({
          where: { isDefault: true, id: { not: id } },
        });
        if (others === 0) {
          throw new BadRequestException(
            'At least one plan must stay the default — make another plan the default first',
          );
        }
      }
      if (dto.isDefault) {
        await tx.plan.updateMany({ data: { isDefault: false } });
      }
      // maxVenues 0 floors to 1 (see createPlan) — a zero venue cap
      // locks out every new owner.
      const maxVenues =
        dto.maxVenues === undefined
          ? undefined
          : dto.maxVenues === 0
            ? 1
            : dto.maxVenues;
      return tx.plan.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.priceYearly !== undefined
            ? { priceYearly: Math.round(dto.priceYearly) }
            : {}),
          ...(dto.freeMonths !== undefined ? { freeMonths: dto.freeMonths } : {}),
          ...(dto.features !== undefined ? { features: dto.features } : {}),
          ...(maxVenues !== undefined ? { maxVenues } : {}),
          ...(dto.maxCourts !== undefined ? { maxCourts: dto.maxCourts } : {}),
          ...(dto.maxStaff !== undefined ? { maxStaff: dto.maxStaff } : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        },
      });
    });
    return { ...plan, features: this.asKeys(plan.features) };
  }

  async deletePlan(id: string) {
    // Guards + delete under the plan-write lock: two concurrent
    // deletes used to both pass the "sole plan" read.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${PLAN_WRITE_LOCK})`;
      const plan = await tx.plan.findUnique({
        where: { id },
        include: { _count: { select: { venues: true, payments: true, frozenVenues: true } } },
      });
      if (!plan) throw new NotFoundException('Plan not found');
      if (plan.isDefault) {
        throw new BadRequestException('The default plan cannot be deleted — make another plan the default first');
      }
      // The sole plan cannot go either: deleting it leaves zero plans
      // and no default for venues to bill against — approved venues
      // would run with billing started but no plan and no gates.
      const totalPlans = await tx.plan.count();
      if (totalPlans <= 1) {
        throw new BadRequestException('The only plan cannot be deleted — create another plan first');
      }
      if (plan._count.venues > 0) {
        throw new BadRequestException(`This plan still has ${plan._count.venues} venue(s) on it — move them first`);
      }
      // Frozen venues pin this plan as their frozenPlanId (plan-change
      // freeze): deleting the plan would leave their frozen period
      // pointing at a deleted plan (SetNull) while the frozen price
      // still governs — refuse until the freeze is resolved by a
      // restart or a settled period, like the venue/payment guards.
      if (plan._count.frozenVenues > 0) {
        throw new BadRequestException(
          `This plan still freezes ${plan._count.frozenVenues} venue(s) — resolve those freezes first`,
        );
      }
      // Ledger rows reference the plan for receipt plan names (the
      // relation is SetNull, so a delete would silently blank history).
      // Keep the plan while any payment references it.
      if (plan._count.payments > 0) {
        throw new BadRequestException(
          `This plan still has ${plan._count.payments} payment record(s) on it — it cannot be deleted while its receipts exist`,
        );
      }
      await tx.plan.delete({ where: { id } });
      return { message: 'Plan deleted' };
    });
  }

  /**
   * Void a wrong mark-paid: a compensating reversing ledger row (negative
   * amount, same period) plus rolling the venue's paid flag back. Only
   * the LATEST standing settlement may be voided (Round 4, R-S13) —
   * voiding a middle period used to punch a hole in the paid chain
   * while the flag still claimed the later periods paid, so voids now
   * unwind from the front: void the later payment(s) first. The
   * reversal is keyed by note `void:<paymentId>`, so a second void
   * of the same payment is a clean 409, not a second reversal. Revenue
   * sums net out (original + reversal = 0). A freeUntilOverride
   * stacked onto the voided period's coverage rewinds with it
   * (R-S14) — otherwise the override kept the venue free past the
   * voided period and the flag rollback was a no-op.
   */
  async voidPayment(venueId: string, paymentId: string, actorId?: string) {
    const payment = await this.prisma.venuePayment.findUnique({
      where: { id: paymentId },
    });
    if (!payment || payment.venueId !== venueId) {
      throw new NotFoundException('Payment not found for this venue');
    }
    if (payment.method === 'void') {
      throw new BadRequestException('This row is itself a reversal — it cannot be voided');
    }
    // A period-less row has no coverage to roll back (R-S15): the flag
    // rollback and the override rewind both need the period, so such
    // rows are refused instead of half-unwound.
    if (!payment.periodStart || !payment.periodEnd) {
      throw new BadRequestException('This payment has no billing period — it cannot be voided');
    }
    // The already-check matches the partial unique index exactly
    // (R-T2): note AND method = 'void', so an ordinary payment that
    // happens to carry the same note text never blocks a void.
    const already = await this.prisma.venuePayment.findFirst({
      where: { venueId, method: 'void', note: `void:${paymentId}` },
    });
    if (already) {
      throw new BadRequestException('This payment was already voided');
    }
    // Only the latest STANDING settlement may be voided. A later
    // payment whose own void already reversed it does not block — the
    // chain is unwound from the front, so a voided later period is
    // already out of the chain.
    const laterPayments = await this.prisma.venuePayment.findMany({
      where: {
        venueId,
        method: { not: 'void' },
        id: { not: paymentId },
        periodEnd: { gt: payment.periodEnd },
      },
      select: { id: true },
    });
    if (laterPayments.length > 0) {
      const voidedNotes = await this.prisma.venuePayment.findMany({
        where: {
          venueId,
          method: 'void',
          note: { in: laterPayments.map((p) => `void:${p.id}`) },
        },
        select: { note: true },
      });
      const voidedIds = new Set(voidedNotes.map((v) => (v.note ?? '').slice(5)));
      const standing = laterPayments.filter((p) => !voidedIds.has(p.id));
      if (standing.length > 0) {
        throw new BadRequestException(
          'Only the latest settlement can be voided — void the later payment(s) first',
        );
      }
    }
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    // The already-check above is fail-fast only: two concurrent voids
    // both pass it, so the insert itself must be the backstop — the
    // partial unique index on note WHERE method = 'void' turns the
    // loser's insert into P2002, mapped here to the same 409 as the
    // sequential path (never a raw 500, never a second reversal).
    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await tx.venuePayment.create({
          data: {
            venueId,
            planId: payment.planId,
            amount: -payment.amount,
            method: 'void',
            note: `void:${paymentId}`,
            periodStart: payment.periodStart,
            periodEnd: payment.periodEnd,
            recordedById: actorId ?? null,
          },
        });
        // Roll the paid flag back when this payment is still the
        // latest settlement (paidUntil within this period), and rewind
        // a freeUntilOverride stacked past this period's start — the
        // extension was stacked onto the coverage being voided, so it
        // collapses to the same point. An override at or before the
        // period start predates the voided coverage and is left alone.
        const venueData: Prisma.VenueUpdateInput = {};
        if (
          venue.billingPaidUntil &&
          payment.periodEnd &&
          venue.billingPaidUntil <= payment.periodEnd
        ) {
          venueData.billingPaidUntil = payment.periodStart;
        }
        if (
          venue.freeUntilOverride &&
          payment.periodStart &&
          venue.freeUntilOverride > payment.periodStart
        ) {
          venueData.freeUntilOverride = payment.periodStart;
        }
        if (Object.keys(venueData).length > 0) {
          await tx.venue.update({ where: { id: venueId }, data: venueData });
        }
        return { voided: true, paymentId, amount: payment.amount };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('This payment was already voided');
      }
      throw e;
    }
    return result;
  }

  async defaultPlan() {
    return this.prisma.plan.findFirst({ where: { isDefault: true } });
  }

  // ------------------------------------------------------------- assignment
  /** Venue approval hook: default plan + billing clock start. */
  async startBilling(venueId: string) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue || venue.billingStartAt) return venue;
    const def = await this.defaultPlan();
    return this.prisma.venue.update({
      where: { id: venueId },
      data: {
        billingStartAt: new Date(),
        planId: venue.planId ?? def?.id ?? null,
      },
    });
  }

  /**
   * Billing actions only make sense for a live arena. An archived venue
   * must not gain ledger rows or an un-pause, and a venue that never
   * went live must not have its billing clock started sideways.
   */
  private assertBillableVenue(venue: Venue) {
    if (venue.archivedAt) {
      throw new BadRequestException('This arena is archived — billing actions are not available');
    }
    if (venue.status !== 'approved') {
      throw new BadRequestException('Billing actions apply to live (approved) arenas');
    }
  }

  async assignPlan(venueId: string, planId: string, restartBilling = false) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    this.assertBillableVenue(venue);
    if (restartBilling) {
      // Round-4 R-B2 claim-guard: a restart wipes paidUntil, so a
      // stale retry must never wipe a payment recorded AFTER the last
      // restart. If money landed since the clock was last reset, the
      // admin must void that payment first (explicit) rather than
      // have a retried restart silently erase it. Rs 0 auto-settlements
      // ('auto') are not money, so they never block. No payment since
      // the last restart → the restart proceeds, so legitimate
      // repeated restarts are unaffected.
      if (venue.billingStartAt) {
        const lastPayment = await this.prisma.venuePayment.findFirst({
          // NULL method = a settlement recorded without a method:
          // still money, so it blocks like any other payment.
          where: {
            venueId,
            OR: [
              { method: null },
              { method: { notIn: ['void', 'auto'] } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, createdAt: true },
        });
        if (lastPayment && lastPayment.createdAt > venue.billingStartAt) {
          const voided = await this.prisma.venuePayment.findFirst({
            where: { venueId, method: 'void', note: `void:${lastPayment.id}` },
            select: { id: true },
          });
          if (!voided) {
            throw new BadRequestException(
              'This arena has a payment recorded since its last billing restart — void that payment first, then restart billing.',
            );
          }
        }
      }
      return this.prisma.venue.update({
        where: { id: venueId },
        data: {
          planId,
          billingStartAt: new Date(),
          billingPaidUntil: null,
          freeUntilOverride: null,
          billingPeriodStart: null,
          billingPeriodEnd: null,
          billingPeriodPrice: null,
          frozenPlanId: null,
          billingPaused: false,
          billingDueNotifiedFor: null,
        },
        include: { plan: true },
      });
    }
    // Unchecked input: planId is a scalar FK, which the checked
    // VenueUpdateInput (relation-only) does not accept.
    const data: Prisma.VenueUncheckedUpdateInput = { planId };
    if (planId !== venue.planId && !venue.billingPeriodStart) {
      // Freeze the period in effect BEFORE the switch: without this,
      // the new plan's freeMonths would retroactively re-anchor every
      // period boundary (a trial venue switched to a 0-free-months plan
      // would instantly go due; a longer-free plan would resurrect an
      // overdue venue into "trial" with no payment). The frozen plan
      // id freezes features/caps the same way: the new plan's limits
      // apply only once this period ends.
      const ctx = await this.context(venue);
      if (ctx) {
        data.billingPeriodStart = ctx.periodStart;
        data.billingPeriodEnd = ctx.periodEnd;
        data.billingPeriodPrice = ctx.plan.priceYearly;
        data.frozenPlanId = ctx.plan.id;
      }
    }
    // Deliberately no billingStartAt here: assigning a plan never starts
    // the billing clock. Only approval (startBilling) or an explicit
    // restart does — otherwise "set the plan for later" bills immediately.
    return this.prisma.venue.update({
      where: { id: venueId },
      data,
      include: { plan: true },
    });
  }

  async extendFree(venueId: string, months: number) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      include: { plan: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    this.assertBillableVenue(venue);
    const summary = await this.billingSummary(venue);
    const now = new Date();
    const freeUntil = summary.freeUntil ? new Date(summary.freeUntil) : null;
    // Stack onto paid coverage when paid, else onto the later of the
    // current free date and now — never onto a long-past free date,
    // which made the extension a no-op for due/overdue venues.
    const base =
      venue.billingPaidUntil && venue.billingPaidUntil > now
        ? venue.billingPaidUntil
        : freeUntil && freeUntil > now
          ? freeUntil
          : now;
    const newFreeUntil = addMonths(base, months);
    const updated = await this.prisma.venue.update({
      where: { id: venueId },
      data: {
        freeUntilOverride: newFreeUntil,
        // Only un-pause when the venue is actually free again; an
        // extension that still ends in the past must not revive it.
        ...(newFreeUntil > now ? { billingPaused: false } : {}),
        // A new free anchor re-derives periods — drop any frozen period
        // and its frozen plan with it.
        billingPeriodStart: null,
        billingPeriodEnd: null,
        billingPeriodPrice: null,
        frozenPlanId: null,
      },
      include: { plan: true },
    });
    return updated;
  }

  /** Settle the current period: paid through its end boundary. */
  async markPaid(
    venueId: string,
    actorId?: string,
    opts?: { method?: string; note?: string; amount?: number },
  ) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      include: { plan: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    this.assertBillableVenue(venue);
    if (opts?.method && !PAYMENT_METHODS.includes(opts.method)) {
      throw new BadRequestException(
        `Unknown payment method — expected one of: ${PAYMENT_METHODS.join(', ')}`,
      );
    }
    let amount: number | undefined;
    if (opts?.amount !== undefined) {
      // Raw comparison, never rounded first: rounding let a typed
      // Rs 35,999.60 pass as the Rs 36,000 period price, and the
      // receipt then overstated what was actually paid. A non-exact
      // amount is rejected by the equality check below.
      amount = Number(opts.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new BadRequestException('Payment amount must be a positive number');
      }
    }
    const ctx = await this.context(venue);
    if (!ctx) throw new BadRequestException('Billing has not started for this venue');
    // Idempotency: this period is already settled — a retry or
    // double-click must not create a second ledger row and double the
    // subscription revenue.
    if (ctx.paidUntil && ctx.paidUntil >= ctx.periodEnd) {
      throw new BadRequestException('This billing period is already paid');
    }
    // Full settlement only: any positive amount used to settle the
    // whole year, and a top-up afterwards was impossible (the period
    // was already marked paid). The panel modal already promises full
    // settlement, so a mismatched amount is a caller error, not a
    // partial payment.
    //
    // Re-mark after a void (Round 4, R-S16): a period settled, voided,
    // and settled again must settle at its ORIGINAL amount, not the
    // current plan price — the plan may have repriced since the void,
    // and charging the new price would rewrite the period's ledger
    // history. The latest void reversal for this exact period points
    // at the original payment via its note.
    let expectedPrice = ctx.price;
    const voided = await this.prisma.venuePayment.findFirst({
      where: {
        venueId,
        method: 'void',
        periodStart: ctx.periodStart,
        periodEnd: ctx.periodEnd,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (voided?.note?.startsWith('void:')) {
      const original = await this.prisma.venuePayment.findUnique({
        where: { id: voided.note.slice(5) },
      });
      if (original) expectedPrice = Number(original.amount);
    }
    if (amount !== undefined && amount !== expectedPrice) {
      throw new BadRequestException(
        `Payment amount must equal the period price (Rs ${expectedPrice.toLocaleString('en-PK')}) — partial payments are not accepted`,
      );
    }
    const paidUntil =
      ctx.paidUntil && ctx.paidUntil > ctx.periodEnd
        ? ctx.paidUntil
        : ctx.periodEnd;
    // Flag update + ledger insert in ONE transaction: a failed insert
    // must not leave the venue marked paid with no ledger row.
    return this.prisma.$transaction(async (tx) => {
      // Claim the settlement inside the transaction: the
      // idempotency check above races a concurrent mark-paid, which
      // used to sail past it and insert a second ledger row, doubling
      // revenue. The claim re-tests "period still unpaid" (paidUntil
      // still before this period's end) on the current row state — the
      // loser gets "already paid" and inserts nothing.
      const claimed = await tx.venue.updateMany({
        where: {
          id: venueId,
          OR: [{ billingPaidUntil: null }, { billingPaidUntil: { lt: ctx.periodEnd } }],
        },
        data: { billingPaidUntil: paidUntil, billingPaused: false },
      });
      if (claimed.count === 0) {
        throw new BadRequestException('This billing period is already paid');
      }
      const updated = await tx.venue.findUniqueOrThrow({
        where: { id: venueId },
        include: { plan: true },
      });
      // Every settlement lands in the payments ledger, so platform revenue
      // is a sum of records — never a guess from flags. The amount is
      // always the period price (validated above), or the voided
      // original's amount on a re-mark after a void (R-S16): a
      // settlement covers exactly one whole period, never part of one.
      await tx.venuePayment.create({
        data: {
          venueId,
          planId: ctx.plan.id,
          amount: amount ?? expectedPrice,
          method: opts?.method ?? null,
          note: opts?.note ?? null,
          periodStart: ctx.periodStart,
          periodEnd: ctx.periodEnd,
          recordedById: actorId ?? null,
        },
      });
      return updated;
    });
  }

  // ---------------------------------------------------------------- billing
  private asKeys(features: Prisma.JsonValue): string[] {
    return Array.isArray(features)
      ? features.filter((x): x is string => typeof x === 'string')
      : [];
  }

  private assertFeatures(keys: string[]) {
    const valid = new Set(PLAN_FEATURES.map((f) => f.key));
    const bad = keys.filter((k) => !valid.has(k));
    if (bad.length > 0) {
      throw new BadRequestException(`Unknown plan feature(s): ${bad.join(', ')}`);
    }
  }

  private async graceDays(): Promise<number> {
    const s = await this.prisma.setting.findUnique({
      where: { key: 'billingGraceDays' },
    });
    const n = s ? Number(s.value) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : 14;
  }

  /** Effective plan for a venue: its own plan, else the platform default. */
  async effectivePlan(venue: { planId: string | null }) {
    if (venue.planId) {
      const own = await this.prisma.plan.findUnique({ where: { id: venue.planId } });
      if (own) return own;
    }
    return this.defaultPlan();
  }

  private async context(venue: Venue & { plan?: unknown }) {
    if (!venue.billingStartAt) return null;
    const plan = await this.effectivePlan(venue);
    if (!plan) return null;
    const freeUntil =
      venue.freeUntilOverride ??
      addMonths(venue.billingStartAt, plan.freeMonths);
    const now = new Date();
    // Yearly periods. When a plan changed without restart, the frozen
    // period (set by assignPlan) is the anchor: its locked price
    // applies while that period is current — the new plan's price
    // applies from the next period, not this one.
    //
    // FREEZE RULE: periods advance only while PAID. The old
    // now-driven walk silently erased arrears: each anniversary moved
    // the due date forward, an overdue venue auto-resumed, and the
    // unpaid year vanished from every figure. Now the walk stops at
    // the first unpaid period and the venue stays due/overdue until
    // that period is settled — no auto-resume without payment.
    let periodStart: Date;
    let periodEnd: Date;
    let price: number;
    if (venue.billingPeriodStart && venue.billingPeriodEnd) {
      periodStart = venue.billingPeriodStart;
      periodEnd = venue.billingPeriodEnd;
      while (venue.billingPaidUntil && venue.billingPaidUntil >= periodEnd) {
        periodStart = periodEnd;
        periodEnd = addMonths(periodStart, 12);
      }
      // The locked price belongs to the frozen period itself: once the
      // walk advances past it (because it was paid), the current
      // plan's price applies to the new period.
      price =
        periodStart.getTime() === venue.billingPeriodStart.getTime() &&
        venue.billingPeriodPrice != null
          ? venue.billingPeriodPrice
          : plan.priceYearly;
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
      price = plan.priceYearly;
    }
    return {
      plan,
      freeUntil,
      periodStart,
      periodEnd,
      price,
      paidUntil: venue.billingPaidUntil,
      now,
    };
  }

  async billingSummary(
    venue: Venue & { plan?: unknown },
  ): Promise<BillingSummary> {
    const plan = await this.effectivePlan(venue);
    const base: BillingSummary = {
      status: 'none',
      planId: plan?.id ?? null,
      planName: plan?.name ?? null,
      priceYearly: plan?.priceYearly ?? null,
      freeUntil: null,
      nextDueAt: null,
      amountDue: 0,
      paidUntil: venue.billingPaidUntil?.toISOString() ?? null,
      billingPaused: venue.billingPaused,
      graceEndsAt: null,
    };
    const ctx = await this.context(venue);
    if (!ctx) return base;
    const { freeUntil, periodStart, paidUntil, now } = ctx;
    base.freeUntil = freeUntil.toISOString();

    if (now < freeUntil) {
      const prepaid = paidUntil && paidUntil >= freeUntil;
      return {
        ...base,
        status: 'trial',
        nextDueAt: prepaid
          ? paidUntil.toISOString()
          : freeUntil.toISOString(),
        // Trial means nothing is due yet — the yearly price is the
        // upcoming amount (shown via priceYearly), never a current due.
        amountDue: 0,
      };
    }
    if (paidUntil && paidUntil > now) {
      return {
        ...base,
        status: 'active',
        nextDueAt: paidUntil.toISOString(),
        amountDue: 0,
      };
    }
    // A zero-price period is not a debt: it never goes due/overdue.
    // The sweep auto-settles it (see sweepBilling), but between the
    // period start and the next sweep the panel must not show a Rs 0
    // "due" with disabled Mark paid buttons — report it active.
    if (ctx.price === 0) {
      return {
        ...base,
        status: 'active',
        nextDueAt: ctx.periodEnd.toISOString(),
        amountDue: 0,
      };
    }
    const grace = await this.graceDays();
    const graceEnd = new Date(periodStart.getTime() + grace * 24 * 3600_000);
    const overdue = now > graceEnd;
    return {
      ...base,
      status: overdue ? 'overdue' : 'due',
      nextDueAt: periodStart.toISOString(),
      amountDue: ctx.price,
      graceEndsAt: graceEnd.toISOString(),
    };
  }

  /** Nightly sweep: pause overdue venues + notify owners. Pause-only — see below. */
  async sweepBilling() {
    // Billing freeze, first half (S6): a suspended owner's venues are
    // skipped entirely — no pause/resume transition, no due reminder
    // — while the arenas are hidden. The clock itself is forgiven on
    // unsuspend (see admin.forgiveSuspensionBillingWindow), so the
    // sweep skipping here never strands a venue in a stale state.
    const venues = await this.prisma.venue.findMany({
      where: {
        status: 'approved',
        billingStartAt: { not: null },
        owner: { status: 'active' },
      },
      include: { plan: true, owner: { select: { id: true, name: true } } },
    });
    let paused = 0;
    // Sweep never resumes (see below); kept for return-shape compat.
    const resumed = 0;
    for (const venue of venues) {
      // Zero-price periods auto-settle: a Rs 0 period is not a debt.
      // The old code let it go due → overdue → sweep-paused with
      // bookings cancelled, while both Mark paid buttons were disabled
      // at amountDue <= 0 — a venue stuck with no settlement path.
      // Settle every consecutive started zero-price period (paidUntil =
      // period end, un-pause) so the walk advances to the first priced
      // period, and venues already paused over a Rs 0 debt come back.
      // Each iteration settles one period, so the loop ends at the
      // first priced or not-yet-started period.
      let settledVenue = venue;
      let autoSettled = false;
      for (;;) {
        const ctx = await this.context(settledVenue);
        if (!ctx || ctx.price !== 0) break;
        if (ctx.periodStart > new Date()) break;
        if (ctx.paidUntil && ctx.paidUntil >= ctx.periodEnd) break;
        settledVenue = await this.prisma.$transaction(async (tx) => {
          const updated = await tx.venue.update({
            where: { id: venue.id },
            data: { billingPaidUntil: ctx.periodEnd, billingPaused: false },
            include: { plan: true, owner: { select: { id: true, name: true } } },
          });
          // The settlement lands in the ledger like every other one
          // (Round 4, R-S17): the old flag-only settle left the
          // ledger, the payment history, and void all disagreeing
          // about which periods were settled. A Rs 0 row with method
          // 'auto' makes all three see the same settlements.
          await tx.venuePayment.create({
            data: {
              venueId: venue.id,
              planId: ctx.plan.id,
              amount: 0,
              method: 'auto',
              note: null,
              periodStart: ctx.periodStart,
              periodEnd: ctx.periodEnd,
              recordedById: null,
            },
          });
          return updated;
        });
        autoSettled = true;
        await this.prisma.auditLog
          .create({
            data: {
              actorId: null,
              action: 'venue.billing.auto_settled',
              entity: 'venue',
              entityId: venue.id,
              details: `zero-price period ${ctx.periodStart.toISOString().slice(0, 10)} – ${ctx.periodEnd.toISOString().slice(0, 10)} settled automatically (Rs 0 plan)`,
            },
          })
          .catch(() => {});
      }
      if (autoSettled && venue.billingPaused) {
        await this.notifications
          .pushToUser(venue.ownerId, {
            title: 'Venue live again',
            body: `${venue.name} is visible to players again — its plan periods cost Rs 0, so they settle automatically and never pause the venue.`,
            data: { type: 'billing_settled' },
          })
          .catch(() => {});
      }
      const summary = await this.billingSummary(settledVenue);
      const shouldPause = summary.status === 'overdue';
      // Pause-only sweep: a billing-paused venue resumes solely via an
      // explicit action (markPaid, extendFree, plan restart) — never via
      // a settings change. Raising billingGraceDays used to flip overdue
      // venues back to due and auto-resume them with zero payment, so
      // grace changes now only affect computed status display for
      // venues that are not paused.
      if (shouldPause && !settledVenue.billingPaused) {
        // Re-read at decision time + claim the pause: a mark-paid
        // landing between the sweep's snapshot and this write used to
        // be overwritten by the pause, and re-marking was then refused
        // ("already paid"). The fresh summary decides, and the
        // conditional update (still unpaused AND still unpaid for this
        // period) makes the sweep lose that race — a settled period
        // never gets paused, and the cascade below runs only when the
        // pause actually claimed.
        const fresh = await this.prisma.venue.findUnique({
          where: { id: venue.id },
        });
        const freshCtx = fresh ? await this.context(fresh) : null;
        const freshSummary = fresh ? await this.billingSummary(fresh) : null;
        const stillOverdue =
          !!fresh &&
          !!freshCtx &&
          freshSummary?.status === 'overdue' &&
          !fresh.billingPaused;
        let claimed = false;
        if (stillOverdue) {
          const res = await this.prisma.venue.updateMany({
            where: {
              id: venue.id,
              billingPaused: false,
              OR: [
                { billingPaidUntil: null },
                { billingPaidUntil: { lt: freshCtx!.periodEnd } },
              ],
            },
            data: { billingPaused: true },
          });
          claimed = res.count > 0;
        }
        if (!claimed) continue;
        // The pause that hides a venue (and cancels its bookings) had
        // no audit trail at all. System rows carry a null actor — the
        // panel renders those as "System / automated".
        await this.prisma.auditLog
          .create({
            data: {
              actorId: null,
              action: 'venue.billing.paused',
              entity: 'venue',
              entityId: venue.id,
              details: `overdue: Rs ${freshSummary!.amountDue.toLocaleString('en-PK')} due for period ${freshSummary!.nextDueAt ?? 'unknown'}`,
            },
          })
          .catch(() => {});
        paused++;
        // Overdue-pause follows the sanction policy: upcoming
        // bookings do not stand at a venue players can no longer see.
        await this.bookings
          .cancelVenueUpcomingBookings(venue.id, 'the arena\'s plan payment is overdue')
          .catch(() => {});
        await this.notifications
          .pushToUser(venue.ownerId, {
            title: 'Venue paused — plan payment overdue',
            body: `${venue.name} is hidden from players until the yearly plan fee is settled. Contact Areana to reactivate instantly.`,
            data: { type: 'billing_overdue' },
          })
          .catch(() => {});
      }
      // One due-reminder per period. The key is the period's start
      // (nextDueAt): frozen billing periods make it stable across
      // plan changes within the same period. The push goes FIRST and
      // the record is written only after it resolves, so a failed
      // send does not burn the period's one reminder — with the caveat
      // that pushToUser swallows inbox/FCM failures internally and
      // resolves anyway, so "after a successful push" here means
      // after the push attempt completed, not after delivery.
      if (summary.status === 'due' && summary.nextDueAt) {
        const periodKey = new Date(summary.nextDueAt);
        const already =
          venue.billingDueNotifiedFor &&
          venue.billingDueNotifiedFor.getTime() === periodKey.getTime();
        if (!already) {
          await this.notifications
            .pushToUser(venue.ownerId, {
              title: 'Plan payment due',
              body: `The yearly plan for ${venue.name} (Rs ${summary.amountDue.toLocaleString('en-PK')}) is now due. Settle within the grace period to keep your venue live.`,
              data: { type: 'billing_due' },
            })
            .catch(() => {});
          await this.prisma.venue.update({
            where: { id: venue.id },
            data: { billingDueNotifiedFor: periodKey },
          });
        }
      }
    }
    return { checked: venues.length, paused, resumed };
  }

  // ----------------------------------------------------------------- gating
  /**
   * Plan whose features/caps actually apply right now. A plan change
   * without restart freezes the OLD plan (frozenPlanId) for the frozen
   * period: the new plan's features/caps apply only once that period
   * ends — i.e. once the paid-advance walk in context() moves past
   * the frozen period's end. Before the freeze existed (or after a
   * restart / free-extension, which clear it), the current plan
   * applies directly.
   */
  private async planInEffect(venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: {
        planId: true,
        frozenPlanId: true,
        billingPeriodStart: true,
        billingPeriodEnd: true,
        billingPaidUntil: true,
      },
    });
    if (!venue) return this.defaultPlan();
    const current = await this.effectivePlan(venue);
    if (!venue.frozenPlanId || !venue.billingPeriodStart || !venue.billingPeriodEnd) {
      return current;
    }
    // Settled frozen period → the walk has moved on; the current plan
    // governs the new period. Unsettled → still the frozen period.
    const settled =
      venue.billingPaidUntil && venue.billingPaidUntil >= venue.billingPeriodEnd;
    if (settled) return current;
    const frozen = await this.prisma.plan.findUnique({ where: { id: venue.frozenPlanId } });
    return frozen ?? current;
  }

  async featuresForVenue(venueId: string): Promise<string[]> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true },
    });
    if (!venue) return [];
    const plan = await this.planInEffect(venueId);
    return plan ? this.asKeys(plan.features) : [];
  }

  async requireFeature(venueId: string, key: string) {
    const features = await this.featuresForVenue(venueId);
    if (!features.includes(key)) {
      const label = PLAN_FEATURES.find((f) => f.key === key)?.label ?? key;
      throw new ForbiddenException(
        `Your current plan doesn't include ${label}. Ask Areana about upgrading your plan.`,
      );
    }
  }

  /** Effective plan for a venue id (own plan, else the default plan). */
  /** The court cap that actually applies to a venue: admin override wins, else the plan's maxCourts. */
  async effectiveCourtLimit(venueId: string): Promise<{
    limit: number | null;
    source: 'override' | 'plan';
    override: number | null;
  }> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { planId: true, courtLimitOverride: true },
    });
    if (!venue) return { limit: null, source: 'plan', override: null };
    if (venue.courtLimitOverride !== null && venue.courtLimitOverride !== undefined) {
      return { limit: venue.courtLimitOverride, source: 'override', override: venue.courtLimitOverride };
    }
    const plan = await this.planInEffect(venueId);
    return { limit: plan?.maxCourts ?? null, source: 'plan', override: null };
  }

  /** The team-seat cap that actually applies: admin override wins, else the plan's maxStaff. */
  async effectiveStaffLimit(venueId: string): Promise<{
    limit: number | null;
    source: 'override' | 'plan';
    override: number | null;
  }> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { planId: true, staffLimitOverride: true },
    });
    if (!venue) return { limit: null, source: 'plan', override: null };
    if (venue.staffLimitOverride !== null && venue.staffLimitOverride !== undefined) {
      return { limit: venue.staffLimitOverride, source: 'override', override: venue.staffLimitOverride };
    }
    const plan = await this.planInEffect(venueId);
    return { limit: plan?.maxStaff ?? null, source: 'plan', override: null };
  }

  async planForVenueId(venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { planId: true },
    });
    if (!venue) return null;
    return this.effectivePlan(venue);
  }

  /** Venue-count limit for an owner, from their venues' plans (or default). */
  async venueLimitForOwner(ownerId: string): Promise<number | null> {
    const venues = await this.prisma.venue.findMany({
      where: { ownerId },
      select: { planId: true },
    });
    if (venues.length === 0) {
      const def = await this.defaultPlan();
      return def?.maxVenues ?? null;
    }
    let limit: number | null = 0;
    for (const v of venues) {
      const plan = await this.effectivePlan(v);
      if (!plan || plan.maxVenues === null) return null; // any unlimited wins
      limit = Math.max(limit ?? 0, plan.maxVenues);
    }
    return limit;
  }
}
