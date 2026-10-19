import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserStatus, VenueStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { QueryVenuesDto } from './dto';

@Injectable()
export class VenuesService {
  constructor(private prisma: PrismaService) {}

  // Public listing — only approved venues are visible to players.
  async list(query: QueryVenuesDto) {
    const { q, city, sport, surface, sort, page = 1, limit = 20 } = query;
    // A suspended owner's venues are paused: hidden from players and
    // unbookable until the owner is reactivated (no state to unwind —
    // the owner's status is the single switch).
    const where: Prisma.VenueWhereInput = {
      status: VenueStatus.approved,
      archivedAt: null,
      billingPaused: false,
      owner: { status: UserStatus.active },
    };
    if (city) where.city = { equals: city, mode: 'insensitive' };
    if (sport) where.sports = { has: sport };
    if (surface) {
      where.courts = {
        some: { isActive: true, surface: { equals: surface, mode: 'insensitive' } },
      };
    }
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { address: { contains: q, mode: 'insensitive' } },
      ];
    }

    // Price sorts need the computed fromPrice, so they page in memory
    // over the (bounded) matching set; the rest page in the database.
    const priceSort = sort === 'price_asc' || sort === 'price_desc';
    const orderBy: Prisma.VenueOrderByWithRelationInput =
      sort === 'name' ? { name: 'asc' } : { rating: 'desc' };
    const findArgs: Prisma.VenueFindManyArgs = {
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
      orderBy,
      ...(priceSort
        ? { take: 500 }
        : { skip: (page - 1) * limit, take: limit }),
    };
    const [total, data] = await Promise.all([
      this.prisma.venue.count({ where }),
      this.prisma.venue.findMany(findArgs),
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
    if (priceSort) {
      const dir = sort === 'price_asc' ? 1 : -1;
      shaped.sort(
        (a: any, b: any) =>
          ((a.fromPrice ?? Number.MAX_SAFE_INTEGER) -
            (b.fromPrice ?? Number.MAX_SAFE_INTEGER)) *
          dir,
      );
      return {
        total,
        page,
        limit,
        data: shaped.slice((page - 1) * limit, page * limit),
      };
    }
    return { total, page, limit, data: shaped };
  }

  /** Distinct court surfaces across approved venues (for the filter dock). */
  async surfaces(): Promise<string[]> {
    const rows = await this.prisma.court.findMany({
      where: {
        isActive: true,
        surface: { not: null },
        venue: { status: VenueStatus.approved, archivedAt: null, billingPaused: false, owner: { status: UserStatus.active } },
      },
      select: { surface: true },
      distinct: ['surface'],
    });
    return rows
      .map((r) => r.surface)
      .filter((x): x is string => !!x && x.trim().length > 0)
      .sort((a, b) => a.localeCompare(b));
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
      where: { id, status: VenueStatus.approved, archivedAt: null, billingPaused: false, owner: { status: UserStatus.active } },
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
