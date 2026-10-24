import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Venue } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { NotificationsService } from '../notifications/notifications.service';
import { BookingsService } from '../bookings/bookings.service';

const PAYMENT_METHODS = ['bank', 'raast', 'cash', 'other'];

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

function addMonths(d: Date, months: number): Date {
  // Clamp to the target month's last day: raw setMonth() overflows
  // (31 Jan + 3 months landed on 1 May, not 30 Apr).
  const day = d.getDate();
  const out = new Date(d);
  out.setDate(1);
  out.setMonth(out.getMonth() + months);
  const last = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
  out.setDate(Math.min(day, last));
  return out;
}

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
      if (dto.isDefault) {
        await tx.plan.updateMany({ data: { isDefault: false } });
      }
      return tx.plan.create({
        data: {
          name: dto.name.trim(),
          priceYearly: Math.round(dto.priceYearly),
          freeMonths: dto.freeMonths ?? 3,
          features: dto.features ?? [],
          maxVenues: dto.maxVenues ?? null,
          maxCourts: dto.maxCourts ?? null,
          maxStaff: dto.maxStaff ?? null,
          isDefault: dto.isDefault ?? false,
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
    // The platform must never be left with zero default plans: venues
    // without their own plan would silently stop being billed or paused.
    if (dto.isDefault === false && existing.isDefault) {
      const others = await this.prisma.plan.count({
        where: { isDefault: true, id: { not: id } },
      });
      if (others === 0) {
        throw new BadRequestException(
          'At least one plan must stay the default — make another plan the default first',
        );
      }
    }
    const plan = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.plan.updateMany({ data: { isDefault: false } });
      }
      return tx.plan.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.priceYearly !== undefined
            ? { priceYearly: Math.round(dto.priceYearly) }
            : {}),
          ...(dto.freeMonths !== undefined ? { freeMonths: dto.freeMonths } : {}),
          ...(dto.features !== undefined ? { features: dto.features } : {}),
          ...(dto.maxVenues !== undefined ? { maxVenues: dto.maxVenues } : {}),
          ...(dto.maxCourts !== undefined ? { maxCourts: dto.maxCourts } : {}),
          ...(dto.maxStaff !== undefined ? { maxStaff: dto.maxStaff } : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        },
      });
    });
    return { ...plan, features: this.asKeys(plan.features) };
  }

  async deletePlan(id: string) {
    const plan = await this.prisma.plan.findUnique({
      where: { id },
      include: { _count: { select: { venues: true, payments: true } } },
    });
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.isDefault) {
      throw new BadRequestException('The default plan cannot be deleted — make another plan the default first');
    }
    if (plan._count.venues > 0) {
      throw new BadRequestException(`This plan still has ${plan._count.venues} venue(s) on it — move them first`);
    }
    // Ledger rows reference the plan for receipt plan names (the
    // relation is SetNull, so a delete would silently blank history).
    // Keep the plan while any payment references it.
    if (plan._count.payments > 0) {
      throw new BadRequestException(
        `This plan still has ${plan._count.payments} payment record(s) on it — it cannot be deleted while its receipts exist`,
      );
    }
    await this.prisma.plan.delete({ where: { id } });
    return { message: 'Plan deleted' };
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
      amount = Math.round(Number(opts.amount));
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
    if (amount !== undefined && amount !== ctx.price) {
      throw new BadRequestException(
        `Payment amount must equal the period price (Rs ${ctx.price.toLocaleString('en-PK')}) — partial payments are not accepted`,
      );
    }
    const paidUntil =
      ctx.paidUntil && ctx.paidUntil > ctx.periodEnd
        ? ctx.paidUntil
        : ctx.periodEnd;
    // Flag update + ledger insert in ONE transaction: a failed insert
    // must not leave the venue marked paid with no ledger row.
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.venue.update({
        where: { id: venueId },
        data: { billingPaidUntil: paidUntil, billingPaused: false },
        include: { plan: true },
      });
      // Every settlement lands in the payments ledger, so platform revenue
      // is a sum of records — never a guess from flags. The amount is
      // always the period price (validated above): a settlement covers
      // exactly one whole period, never part of one.
      await tx.venuePayment.create({
        data: {
          venueId,
          planId: ctx.plan.id,
          amount: amount ?? ctx.price,
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
      const summary = await this.billingSummary(venue);
      const shouldPause = summary.status === 'overdue';
      // Pause-only sweep: a billing-paused venue resumes solely via an
      // explicit action (markPaid, extendFree, plan restart) — never via
      // a settings change. Raising billingGraceDays used to flip overdue
      // venues back to due and auto-resume them with zero payment, so
      // grace changes now only affect computed status display for
      // venues that are not paused.
      if (shouldPause && !venue.billingPaused) {
        await this.prisma.venue.update({
          where: { id: venue.id },
          data: { billingPaused: true },
        });
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
              details: `overdue: Rs ${summary.amountDue.toLocaleString('en-PK')} due for period ${summary.nextDueAt ?? 'unknown'}`,
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
