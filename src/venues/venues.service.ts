import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserStatus, VenueStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { QueryVenuesDto } from './dto';

@Injectable()
export class VenuesService {
  constructor(private prisma: PrismaService) {}

  // Public listing — only approved venues are visible to players.
  async list(query: QueryVenuesDto) {
    const { q, city, sport, page = 1, limit = 20 } = query;
    // A suspended owner's venues are paused: hidden from players and
    // unbookable until the owner is reactivated (no state to unwind —
    // the owner's status is the single switch).
    const where: Prisma.VenueWhereInput = {
      status: VenueStatus.approved,
      archivedAt: null,
      owner: { status: UserStatus.active },
    };
    if (city) where.city = { equals: city, mode: 'insensitive' };
    if (sport) where.sports = { has: sport };
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { address: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [total, data] = await Promise.all([
      this.prisma.venue.count({ where }),
      this.prisma.venue.findMany({
        where,
        include: {
          _count: { select: { courts: true } },
          badges: { include: { badge: true }, orderBy: { badge: { tier: 'desc' } } },
          courts: {
            where: { isActive: true },
            select: {
              pricePerHour: true,
              priceWindows: { select: { pricePerHour: true } },
            },
          },
        },
        orderBy: { rating: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    // fromPrice = the cheapest hour a player could actually pay at this
    // venue: the minimum over active courts of (base rate, any special
    // price-window rate). Courts are stripped from the payload afterwards.
    const shaped = data.map((v: any) => {
      const rates: number[] = [];
      for (const c of v.courts ?? []) {
        rates.push(Number(c.pricePerHour));
        for (const w of c.priceWindows ?? []) rates.push(Number(w.pricePerHour));
      }
      const { courts: _courts, ...rest } = v;
      // Sports shown to players always reflect the actual active courts
      // (venue.sports heals at read time even before owners edit).
      const courtSports = [...new Set((v.courts ?? []).map((c: any) => c.sport).filter(Boolean))];
      return {
        ...rest,
        sports: courtSports.length ? courtSports : rest.sports,
        fromPrice: rates.length ? Math.min(...rates) : null,
      };
    });
    return { total, page, limit, data: shaped };
  }

  /** Distinct cities with at least one approved venue, A-Z. */
  async cities(): Promise<string[]> {
    const rows = await this.prisma.venue.findMany({
      where: { status: VenueStatus.approved },
      select: { city: true },
      distinct: ['city'],
    });
    return rows.map((r) => r.city).sort((a, b) => a.localeCompare(b));
  }

  async getById(id: string) {
    const venue = await this.prisma.venue.findFirst({
      where: { id, status: VenueStatus.approved, archivedAt: null, owner: { status: UserStatus.active } },
      include: {
        courts: { where: { isActive: true }, orderBy: { pricePerHour: 'asc' } },
        badges: { include: { badge: true }, orderBy: { badge: { tier: 'desc' } } },
      },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    const courtSports = [
      ...new Set((venue.courts ?? []).map((c: any) => c.sport).filter(Boolean)),
    ];
    return courtSports.length ? { ...venue, sports: courtSports } : venue;
  }
}
