import { Injectable, NotFoundException } from '@nestjs/common';
import { BookingStatus, VenueStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';

const ACTIVE_BOOKING: BookingStatus[] = [BookingStatus.confirmed, BookingStatus.completed];

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  private async commissionPct(): Promise<number> {
    const s = await this.prisma.setting.findUnique({ where: { key: 'commissionPct' } });
    return parseFloat(s?.value ?? '10');
  }

  // ------------------------------------------------------- 1. platform KPIs
  async overview() {
    const [
      players,
      owners,
      venues,
      bookings,
      gmvAgg,
      pendingBookings,
      pendingOwners,
      pendingVenues,
      openDisputes,
    ] = await Promise.all([
      this.prisma.user.count({ where: { role: { name: 'player' } } }),
      this.prisma.user.count({ where: { role: { name: 'owner' } } }),
      this.prisma.venue.groupBy({ by: ['status'], _count: true }),
      this.prisma.booking.groupBy({ by: ['status'], _count: true, _sum: { totalPrice: true } }),
      this.prisma.booking.aggregate({
        where: { status: { in: ACTIVE_BOOKING } },
        _sum: { totalPrice: true },
      }),
      this.prisma.booking.count({ where: { status: BookingStatus.pending } }),
      this.prisma.user.count({ where: { status: 'pending', role: { name: 'owner' } } }),
      this.prisma.venue.count({ where: { status: VenueStatus.pending } }),
      this.prisma.dispute.count({ where: { status: 'open' } }),
    ]);
    const gmv = Number(gmvAgg._sum.totalPrice ?? 0);
    const pct = await this.commissionPct();
    return {
      players,
      owners,
      venuesByStatus: Object.fromEntries(venues.map((v) => [v.status, v._count])),
      bookingsByStatus: Object.fromEntries(
        bookings.map((b) => [b.status, { count: b._count, revenue: Number(b._sum.totalPrice ?? 0) }]),
      ),
      gmv,
      accruedCommission: Math.round((gmv * pct) / 100),
      pendingApprovals: { bookings: pendingBookings, owners: pendingOwners, venues: pendingVenues },
      openDisputes,
    };
  }

  // ------------------------------------------------- 2. day/week/month graphs
  async trends(days = 30, granularity: 'day' | 'week' | 'month' = 'day') {
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);
    const rows = await this.prisma.booking.groupBy({
      by: ['date'],
      where: { date: { gte: since }, status: { in: ACTIVE_BOOKING } },
      _count: true,
      _sum: { totalPrice: true },
      orderBy: { date: 'asc' },
    });
    const bucket = (d: Date): string => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      if (granularity === 'month') return `${y}-${m}`;
      if (granularity === 'week') {
        const onejan = new Date(y, 0, 1);
        const week = Math.ceil(((d.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7);
        return `${y}-W${String(week).padStart(2, '0')}`;
      }
      return `${y}-${m}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const map = new Map<string, { bookings: number; gmv: number }>();
    for (const r of rows) {
      const k = bucket(r.date);
      const e = map.get(k) ?? { bookings: 0, gmv: 0 };
      e.bookings += r._count;
      e.gmv += Number(r._sum.totalPrice ?? 0);
      map.set(k, e);
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([period, v]) => ({ period, ...v, gmv: Math.round(v.gmv) }));
  }

  // ---------------------------------------------------------- 3. breakdowns
  async breakdown() {
    const [byCity, bySport, venueStatus] = await Promise.all([
      this.prisma.venue.groupBy({ by: ['city'], _count: true }),
      this.prisma.court.groupBy({ by: ['sport'], _count: true }),
      this.prisma.venue.groupBy({ by: ['status'], _count: true }),
    ]);
    const cityBookings = await this.prisma.booking.groupBy({
      by: ['venueId'],
      where: { status: { in: ACTIVE_BOOKING } },
      _count: true,
      _sum: { totalPrice: true },
    });
    const venueCity = new Map(
      (await this.prisma.venue.findMany({ select: { id: true, city: true } })).map((v) => [v.id, v.city]),
    );
    const cityStats = new Map<string, { bookings: number; gmv: number }>();
    for (const b of cityBookings) {
      const city = venueCity.get(b.venueId) ?? 'Unknown';
      const e = cityStats.get(city) ?? { bookings: 0, gmv: 0 };
      e.bookings += b._count;
      e.gmv += Number(b._sum.totalPrice ?? 0);
      cityStats.set(city, e);
    }
    return {
      cities: byCity.map((c) => ({
        city: c.city,
        venues: c._count,
        ...(cityStats.get(c.city) ?? { bookings: 0, gmv: 0 }),
      })),
      sports: bySport.map((s) => ({ sport: s.sport, courts: s._count })),
      venueStatus: Object.fromEntries(venueStatus.map((v) => [v.status, v._count])),
    };
  }

  // ------------------------------------------------- 4. arena leaderboard
  async venueLeaderboard() {
    const venues = await this.prisma.venue.findMany({
      where: { status: VenueStatus.approved },
      select: {
        id: true,
        name: true,
        city: true,
        rating: true,
        ratingCount: true,
        badges: { include: { badge: true }, orderBy: { badge: { tier: 'desc' } } },
      },
    });
    const rows: any[] = [];
    for (const v of venues) {
      const bookings = await this.prisma.booking.findMany({
        where: { venueId: v.id },
        select: { userId: true, date: true, status: true, totalPrice: true, startMinutes: true, endMinutes: true },
      });
      const active = bookings.filter((b) => ACTIVE_BOOKING.includes(b.status));
      const revenue = active.reduce((s, b) => s + Number(b.totalPrice), 0);
      const players = new Set(bookings.map((b) => b.userId).filter(Boolean));
      const noShows = bookings.filter((b) => b.status === BookingStatus.no_show).length;
      const bookedMin = active.reduce((s, b) => s + (b.endMinutes - b.startMinutes), 0);
      const courts = await this.prisma.court.findMany({
        where: { venueId: v.id, isActive: true },
        select: { openMinutes: true, closeMinutes: true },
      });
      const days = new Set(bookings.map((b) => b.date.toISOString().slice(0, 10))).size || 1;
      const availMin = courts.reduce((s, c) => s + Math.max(0, c.closeMinutes - c.openMinutes), 0) * days;
      // New vs returning: first booking date per player at this venue.
      const firstSeen = new Map<string, string>();
      const sorted = [...bookings].sort((a, b) => a.date.getTime() - b.date.getTime());
      for (const b of sorted) {
        if (b.userId && !firstSeen.has(b.userId)) {
          firstSeen.set(b.userId, b.date.toISOString().slice(0, 10));
        }
      }
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      const newPlayers = [...firstSeen.values()].filter((d) => d >= cutoff.toISOString().slice(0, 10)).length;
      rows.push({
        venueId: v.id,
        name: v.name,
        city: v.city,
        rating: v.rating,
        ratingCount: v.ratingCount,
        topBadge: v.badges[0]?.badge.name ?? null,
        bookings: bookings.length,
        revenue: Math.round(revenue),
        occupancyPct: availMin > 0 ? Math.round((bookedMin / availMin) * 100) : 0,
        uniquePlayers: players.size,
        newPlayers30d: newPlayers,
        returningPlayers: players.size - newPlayers,
        noShows,
      });
    }
    rows.sort((a, b) => b.revenue - a.revenue);
    return rows;
  }

  // ------------------------------------------------------- 5a. venue drill-down
  async venueDetail(venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      include: {
        owner: { select: { name: true, email: true, phone: true } },
        courts: true,
        badges: { include: { badge: true } },
        staff: { include: { user: { select: { name: true, email: true } } } },
      },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    const [bookings, reviews, customers] = await Promise.all([
      this.prisma.booking.findMany({
        where: { venueId },
        include: { court: { select: { name: true } }, user: { select: { name: true } } },
        orderBy: [{ date: 'desc' }, { startMinutes: 'desc' }],
        take: 200,
      }),
      this.prisma.review.findMany({
        where: { venueId },
        include: { user: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.booking.groupBy({
        by: ['userId'],
        where: { venueId, userId: { not: null } },
        _count: true,
      }),
    ]);
    const active = bookings.filter((b) => ACTIVE_BOOKING.includes(b.status));
    return {
      venue,
      kpis: {
        bookings: bookings.length,
        revenue: Math.round(active.reduce((s, b) => s + Number(b.totalPrice), 0)),
        uniqueCustomers: customers.length,
        reviews: reviews.length,
        noShows: bookings.filter((b) => b.status === BookingStatus.no_show).length,
      },
      bookings,
      reviews,
    };
  }

  // ------------------------------------------------------- 5b. owner drill-down
  async ownerDetail(ownerId: string) {
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      include: { role: { select: { name: true } } },
    });
    if (!owner || owner.role.name !== 'owner') throw new NotFoundException('Owner not found');
    const venues = await this.prisma.venue.findMany({
      where: { ownerId },
      select: { id: true, name: true, city: true, status: true, rating: true },
    });
    const perVenue = await Promise.all(
      venues.map(async (v) => {
        const agg = await this.prisma.booking.aggregate({
          where: { venueId: v.id, status: { in: ACTIVE_BOOKING } },
          _count: true,
          _sum: { totalPrice: true },
        });
        return { ...v, bookings: agg._count, revenue: Math.round(Number(agg._sum.totalPrice ?? 0)) };
      }),
    );
    const { passwordHash: _p, ...safe } = owner;
    return {
      owner: safe,
      venues: perVenue,
      totals: {
        venues: venues.length,
        bookings: perVenue.reduce((s, v) => s + v.bookings, 0),
        revenue: perVenue.reduce((s, v) => s + v.revenue, 0),
      },
    };
  }

  // -------------------------------------------------------- 5c. user drill-down
  async userDetail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: { select: { name: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    const [bookings, referralsMade, redemptions, disputes] = await Promise.all([
      this.prisma.booking.findMany({
        where: { userId },
        include: { venue: { select: { name: true } }, court: { select: { name: true } } },
        orderBy: [{ date: 'desc' }],
        take: 100,
      }),
      this.prisma.referral.count({ where: { referrerId: userId } }),
      this.prisma.promoRedemption.count({ where: { userId } }),
      this.prisma.dispute.count({ where: { raisedById: userId } }),
    ]);
    const { passwordHash: _p, ...safe } = user;
    return {
      user: safe,
      kpis: {
        bookings: bookings.length,
        completed: bookings.filter((b) => b.status === BookingStatus.completed).length,
        noShows: bookings.filter((b) => b.status === BookingStatus.no_show).length,
        cancelled: bookings.filter((b) => b.status === BookingStatus.cancelled).length,
        referralsMade,
        promoRedemptions: redemptions,
        disputes,
      },
      bookings,
    };
  }
}
