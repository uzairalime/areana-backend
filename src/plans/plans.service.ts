import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Venue } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { NotificationsService } from '../notifications/notifications.service';

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
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setMonth(out.getMonth() + months);
  return out;
}

@Injectable()
export class PlansService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
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
      include: { _count: { select: { venues: true } } },
    });
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.isDefault) {
      throw new BadRequestException('The default plan cannot be deleted — make another plan the default first');
    }
    if (plan._count.venues > 0) {
      throw new BadRequestException(`This plan still has ${plan._count.venues} venue(s) on it — move them first`);
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

  async assignPlan(venueId: string, planId: string, restartBilling = false) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    const updated = await this.prisma.venue.update({
      where: { id: venueId },
      data: {
        planId,
        ...(restartBilling
          ? {
              billingStartAt: new Date(),
              billingPaidUntil: null,
              freeUntilOverride: null,
              billingPaused: false,
              billingDueNotifiedFor: null,
            }
          : venue.billingStartAt
            ? {}
            : { billingStartAt: new Date() }),
      },
      include: { plan: true },
    });
    return updated;
  }

  async extendFree(venueId: string, months: number) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      include: { plan: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    const summary = await this.billingSummary(venue);
    const base = summary.freeUntil ? new Date(summary.freeUntil) : new Date();
    const freeUntil = addMonths(base, months);
    const updated = await this.prisma.venue.update({
      where: { id: venueId },
      data: { freeUntilOverride: freeUntil, billingPaused: false },
      include: { plan: true },
    });
    return updated;
  }

  /** Settle the current period: paid through its end boundary. */
  async markPaid(
    venueId: string,
    actorId?: string,
    opts?: { method?: string; note?: string },
  ) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      include: { plan: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    const ctx = await this.context(venue);
    if (!ctx) throw new BadRequestException('Billing has not started for this venue');
    const paidUntil =
      ctx.paidUntil && ctx.paidUntil > ctx.periodEnd
        ? ctx.paidUntil
        : ctx.periodEnd;
    const updated = await this.prisma.venue.update({
      where: { id: venueId },
      data: { billingPaidUntil: paidUntil, billingPaused: false },
      include: { plan: true },
    });
    // Every settlement lands in the payments ledger, so platform revenue
    // is a sum of records — never a guess from flags.
    await this.prisma.venuePayment.create({
      data: {
        venueId,
        planId: ctx.plan.id,
        amount: ctx.plan.priceYearly,
        method: opts?.method ?? null,
        note: opts?.note ?? null,
        periodStart: ctx.periodStart,
        periodEnd: ctx.periodEnd,
        recordedById: actorId ?? null,
      },
    });
    return updated;
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
    // Yearly periods anchored at freeUntil.
    let periodStart = freeUntil;
    let periodEnd = addMonths(freeUntil, 12);
    while (now >= periodEnd) {
      periodStart = periodEnd;
      periodEnd = addMonths(periodStart, 12);
    }
    while (now < periodStart && periodStart > freeUntil) {
      periodEnd = periodStart;
      periodStart = addMonths(periodStart, -12);
    }
    return {
      plan,
      freeUntil,
      periodStart,
      periodEnd,
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
        amountDue: prepaid ? 0 : ctx.plan.priceYearly,
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
      amountDue: ctx.plan.priceYearly,
    };
  }

  /** Nightly sweep: flip billingPaused + notify owners on due / overdue. */
  async sweepBilling() {
    const venues = await this.prisma.venue.findMany({
      where: { status: 'approved', billingStartAt: { not: null } },
      include: { plan: true, owner: { select: { id: true, name: true } } },
    });
    let paused = 0;
    let resumed = 0;
    for (const venue of venues) {
      const summary = await this.billingSummary(venue);
      const shouldPause = summary.status === 'overdue';
      if (shouldPause !== venue.billingPaused) {
        await this.prisma.venue.update({
          where: { id: venue.id },
          data: { billingPaused: shouldPause },
        });
        if (shouldPause) paused++;
        else resumed++;
        if (shouldPause) {
          await this.notifications
            .pushToUser(venue.ownerId, {
              title: 'Venue paused — plan payment overdue',
              body: `${venue.name} is hidden from players until the yearly plan fee is settled. Contact Areana to reactivate instantly.`,
              data: { type: 'billing_overdue' },
            })
            .catch(() => {});
        }
      }
      // One due-reminder per period.
      if (summary.status === 'due' && summary.nextDueAt) {
        const periodKey = new Date(summary.nextDueAt);
        const already =
          venue.billingDueNotifiedFor &&
          venue.billingDueNotifiedFor.getTime() === periodKey.getTime();
        if (!already) {
          await this.prisma.venue.update({
            where: { id: venue.id },
            data: { billingDueNotifiedFor: periodKey },
          });
          await this.notifications
            .pushToUser(venue.ownerId, {
              title: 'Plan payment due',
              body: `The yearly plan for ${venue.name} (Rs ${summary.amountDue.toLocaleString('en-PK')}) is now due. Settle within the grace period to keep your venue live.`,
              data: { type: 'billing_due' },
            })
            .catch(() => {});
        }
      }
    }
    return { checked: venues.length, paused, resumed };
  }

  // ----------------------------------------------------------------- gating
  async featuresForVenue(venueId: string): Promise<string[]> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { planId: true },
    });
    if (!venue) return [];
    const plan = await this.effectivePlan(venue);
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
    const plan = await this.effectivePlan(venue);
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
    const plan = await this.effectivePlan(venue);
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
