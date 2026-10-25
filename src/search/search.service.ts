import { Injectable } from '@nestjs/common';
import { VenueStatus, UserStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { AvailabilityService } from '../availability/availability.service';
import { PlansService } from '../plans/plans.service';
import { parseDateOnly, startOfToday } from '../common/date.util';

export interface SlotSearchQuery {
  sport?: string;
  city?: string;
  date: string;
  size?: string;
  indoor?: boolean;
}

/**
 * "Football tonight near DHA" — availability-first discovery.
 * Returns courts (with their venue) that have at least one free slot,
 * each with its bookable slots for the day.
 */
@Injectable()
export class SearchService {
  constructor(
    private prisma: PrismaService,
    private availability: AvailabilityService,
    private plans: PlansService,
  ) {}

  async slotSearch(q: SlotSearchQuery) {
    parseDateOnly(q.date); // validates format
    const venues = await this.prisma.venue.findMany({
      where: {
        status: VenueStatus.approved,
        archivedAt: null,
        billingPaused: false,
        moderationStatus: 'none',
        owner: { status: UserStatus.active },
        ...(q.city ? { city: { equals: q.city, mode: 'insensitive' } } : {}),
        courts: {
          some: {
            isActive: true,
            status: 'approved',
            ...(q.sport ? { sport: { equals: q.sport, mode: 'insensitive' } } : {}),
            ...(q.size ? { size: { equals: q.size, mode: 'insensitive' } } : {}),
            ...(q.indoor !== undefined ? { indoor: q.indoor } : {}),
          },
        },
      },
      select: {
        id: true,
        name: true,
        address: true,
        city: true,
        rating: true,
        images: true,
        photos: true,
        maxAdvanceDays: true,
        billingStartAt: true,
        billingPaidUntil: true,
        freeUntilOverride: true,
        billingPeriodStart: true,
        billingPeriodEnd: true,
        billingPeriodPrice: true,
        planId: true,
        courts: {
          where: {
            isActive: true,
            status: 'approved',
            ...(q.sport ? { sport: { equals: q.sport, mode: 'insensitive' } } : {}),
            ...(q.size ? { size: { equals: q.size, mode: 'insensitive' } } : {}),
            ...(q.indoor !== undefined ? { indoor: q.indoor } : {}),
          },
          select: {
            id: true,
            name: true,
            sport: true,
            size: true,
            surface: true,
            indoor: true,
            pricePerHour: true,
          },
        },
      },
      take: 200,
    });

    // Only venues whose booking window covers the requested date —
    // otherwise search offers slots the booking endpoint will refuse.
    const dayOffset = Math.round(
      (parseDateOnly(q.date).getTime() - startOfToday().getTime()) / 86_400_000,
    );
    const results: any[] = [];
    for (const venue of venues) {
      if (dayOffset > venue.maxAdvanceDays) continue;
      // Live-overdue check, same as discovery: the materialized
      // billingPaused flag only flips on the nightly sweep, so a venue
      // whose grace ended since the last sweep must not be offered
      // here — and its courts' getAvailability calls would throw
      // anyway (getActiveCourt's live-overdue check), which the
      // try/catch below would swallow one court at a time. Filtering
      // up front keeps the whole venue out in one check.
      const summary = await this.plans.billingSummary(venue as any);
      if (summary.status === 'overdue') continue;
      const courts: any[] = [];
      for (const court of venue.courts) {
        // One bad court must never fail the whole search: a court that
        // was deactivated, re-queued, or deleted after the venue query
        // (or whose venue went overdue mid-scan) is skipped, and the
        // search returns every other court's slots.
        let avail;
        try {
          avail = await this.availability.getAvailability(court.id, q.date);
        } catch {
          continue;
        }
        const free = avail.slots.filter((s) => s.available);
        if (free.length > 0) {
          courts.push({ ...court, pricePerHour: Number(court.pricePerHour), availableSlots: free });
        }
      }
      if (courts.length > 0) {
        const {
          courts: _c,
          billingStartAt: _bs,
          billingPaidUntil: _bp,
          freeUntilOverride: _fo,
          billingPeriodStart: _bps,
          billingPeriodEnd: _bpe,
          billingPeriodPrice: _bpp,
          planId: _pid,
          ...v
        } = venue;
        results.push({ venue: v, courts });
      }
    }
    // Best availability first.
    results.sort(
      (a, b) =>
        b.courts.reduce((s: number, c: any) => s + c.availableSlots.length, 0) -
        a.courts.reduce((s: number, c: any) => s + c.availableSlots.length, 0),
    );
    // Cap the payload at the 50 best-covered venues (scan widened above
    // so growing cities don't silently truncate before sorting).
    return { date: q.date, results: results.slice(0, 50) };
  }
}
