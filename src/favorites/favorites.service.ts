import { Injectable, NotFoundException } from '@nestjs/common';
import { UserStatus, VenueStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { cursorPage, encodeCursor, keysetWhere, pageLimit } from '../common/pagination';
import { PlansService } from '../plans/plans.service';

const venueSummary = {
  id: true,
  name: true,
  address: true,
  city: true,
  sports: true,
  images: true,
  rating: true,
  ratingCount: true,
  status: true,
  photos: true,
} as const;

@Injectable()
export class FavoritesService {
  constructor(
    private prisma: PrismaService,
    private plans: PlansService,
  ) {}

  async list(userId: string, cursor?: string, rawLimit?: number) {
    const limit = pageLimit(rawLimit, 30);
    // Round 5, P5-S54: the computed live-overdue check cannot live
    // in the Prisma where-clause, so the page is assembled by
    // scanning keyset batches under the materialized predicate and
    // dropping overdue venues, until limit+1 live rows are collected
    // (the probe cursorPage needs) or the list is exhausted. The
    // cursor still advances over examined rows, so a dropped overdue
    // venue never reappears on the next page.
    const live: Awaited<
      ReturnType<typeof this.prisma.favorite.findMany>
    > = [];
    let scanCursor = cursor;
    for (let batch = 0; batch < 100 && live.length <= limit; batch++) {
      const rows = await this.prisma.favorite.findMany({
        where: {
          userId,
          venue: { status: VenueStatus.approved, archivedAt: null, billingPaused: false, moderationStatus: 'none', owner: { status: UserStatus.active } },
          ...keysetWhere(scanCursor, 'createdAt', 'desc', 'venueId'),
        },
        include: { venue: { select: venueSummary } },
        orderBy: [{ createdAt: 'desc' }, { venueId: 'desc' }],
        take: limit + 1,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        const venue = await this.prisma.venue.findUnique({
          where: { id: row.venueId },
          select: {
            billingStartAt: true,
            billingPaidUntil: true,
            freeUntilOverride: true,
            billingPeriodStart: true,
            billingPeriodEnd: true,
            billingPeriodPrice: true,
            planId: true,
          },
        });
        const overdue =
          venue &&
          (await this.plans.billingSummary(venue as any)).status === 'overdue';
        if (!overdue) live.push(row);
      }
      const last = rows[rows.length - 1];
      scanCursor = encodeCursor(last.createdAt, last.venueId);
      if (rows.length <= limit) break;
    }
    return cursorPage(live, limit, (r) => r.createdAt, undefined, (r) => r.venueId);
  }

  /**
   * Round 5, R5-29: cheap per-venue favorite check. Feasible with NO
   * new index and no pattern bypass: Favorite's PK is exactly
   * (userId, venueId), so this is a single PK lookup — cheaper than
   * paging the favorites list. Returns { favorited: boolean }.
   */
  async check(userId: string, venueId: string) {
    const row = await this.prisma.favorite.findUnique({
      where: { userId_venueId: { userId, venueId } },
      select: { userId: true },
    });
    return { favorited: row !== null };
  }

  async add(userId: string, venueId: string) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    return this.prisma.favorite.upsert({
      where: { userId_venueId: { userId, venueId } },
      update: {},
      create: { userId, venueId },
      include: { venue: { select: venueSummary } },
    });
  }

  async remove(userId: string, venueId: string) {
    await this.prisma.favorite.deleteMany({ where: { userId, venueId } });
    return { message: 'Removed from favorites' };
  }
}
