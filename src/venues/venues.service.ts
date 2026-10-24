import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserStatus, VenueStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { offsetPageFromDb } from '../common/pagination';
import { QueryVenuesDto } from './dto';

@Injectable()
export class VenuesService {
  constructor(private prisma: PrismaService) {}

  // ------------------------------------------------------------ reports
  /**
   * A signed-in player reports an arena (fake listing, closed, misconduct…).
   * One OPEN report per player per arena — a second attempt while one is
   * still open returns a 409 so the queue stays clean.
   */
  async reportVenue(
    userId: string,
    venueId: string,
    body: { category: string; details?: string },
  ) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, ownerId: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    if (venue.ownerId === userId) {
      throw new BadRequestException('You cannot report your own arena.');
    }
    // Outstanding means open OR reviewed: a report under investigation
    // still blocks a duplicate, and counts in the outstanding queue.
    const existing = await this.prisma.venueReport.findFirst({
      where: { venueId, userId, status: { in: ['open', 'reviewed'] } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'You already have an open report for this arena — our team is reviewing it.',
      );
    }
    // Anti-spam: a report the team already closed less than 30 days ago
    // can't be re-filed for the same arena, and one player can hold at
    // most 10 open reports across all arenas.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const recentlyClosed = await this.prisma.venueReport.findFirst({
      where: {
        venueId,
        userId,
        status: { in: ['actioned', 'dismissed'] },
        resolvedAt: { gte: thirtyDaysAgo },
      },
      select: { id: true },
    });
    if (recentlyClosed) {
      throw new ConflictException(
        'You reported this arena recently and our team has already reviewed it.',
      );
    }
    if (
      body.category === 'other' &&
      (!body.details || body.details.trim().length < 10)
    ) {
      throw new BadRequestException(
        'For an "Other" report, please add a few details (at least 10 characters) so our team can act on it.',
      );
    }
    const openCount = await this.prisma.venueReport.count({
      where: { userId, status: 'open' },
    });
    if (openCount >= 10) {
      throw new ConflictException(
        'You have too many open reports right now — please wait for our team to review them.',
      );
    }
    // openKey is the race guard: two concurrent reports both pass the
    // check above, but only one insert with this key can land.
    try {
      return await this.prisma.venueReport.create({
        data: {
          venueId,
          userId,
          category: body.category,
          details: body.details?.trim() || null,
          openKey: `${venueId}:${userId}`,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'You already have an open report for this arena — our team is reviewing it.',
        );
      }
      throw e;
    }
  }

  /** The player's own latest report for this arena (any status), if any. */
  async myVenueReport(userId: string, venueId: string) {
    return this.prisma.venueReport.findFirst({
      where: { venueId, userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, category: true, status: true, createdAt: true },
    });
  }

  // ------------------------------------------------------------ tracking
  /**
   * Record a listing view / click / court view. Deduplicated to one per
   * identity per venue (or court) per Asia/Karachi day by the unique
   * dedupeKey — repeat beacons the same day are no-ops. The venue's own
   * owner never counts. Guests count via their visitor id.
   */
  async recordEvent(
    venueId: string,
    body: { type?: string; courtId?: string; visitorId?: string },
    user?: { id: string },
    ip?: string,
  ) {
    const type = body?.type ?? '';
    if (!['view', 'click', 'court_view'].includes(type)) {
      return { recorded: false };
    }
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, ownerId: true },
    });
    if (!venue) return { recorded: false };
    if (user && user.id === venue.ownerId) return { recorded: false };
    let courtId: string | null = null;
    if (type === 'court_view') {
      if (!body.courtId) return { recorded: false };
      const court = await this.prisma.court.findFirst({
        where: { id: body.courtId, venueId },
        select: { id: true },
      });
      if (!court) return { recorded: false };
      courtId = court.id;
    }
    const dayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
    }).format(new Date());
    const identity = user
      ? user.id
      : body.visitorId
        ? `g:${String(body.visitorId).slice(0, 64)}`
        : `ip:${ip ?? 'unknown'}`;
    const dedupeKey = `${venueId}|${courtId ?? ''}|${type}|${identity}|${dayStr}`;
    await this.prisma.venueEvent.upsert({
      where: { dedupeKey },
      create: {
        venueId,
        courtId,
        type,
        identity,
        userId: user?.id ?? null,
        day: new Date(`${dayStr}T00:00:00.000Z`),
        dedupeKey,
      },
      update: {},
    });
    return { recorded: true };
  }

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
      moderationStatus: 'none',
      owner: { status: UserStatus.active },
    };
    if (city) where.city = { equals: city, mode: 'insensitive' };
    // An arena is only listed while it has at least one BOOKABLE court
    // (active + approved) — an arena whose courts are all off or awaiting
    // approval is a dead end for players, so it leaves discovery until a
    // court comes back. Sport/surface filters narrow that same court set.
    const courtSome: Prisma.CourtWhereInput = { isActive: true, status: 'approved' };
    if (sport) courtSome.sport = { equals: sport, mode: 'insensitive' };
    if (surface) courtSome.surface = { equals: surface, mode: 'insensitive' };
    where.courts = { some: courtSome };
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
          where: { isActive: true, status: 'approved' },
          select: {
            sport: true,
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
      return offsetPageFromDb(
        shaped.slice((page - 1) * limit, page * limit),
        total,
        page,
        limit,
      );
    }
    return offsetPageFromDb(shaped, total, page, limit);
  }

  /** Distinct court surfaces across approved venues (for the filter dock). */
  async surfaces(): Promise<string[]> {
    const rows = await this.prisma.court.findMany({
      where: {
        isActive: true,
        surface: { not: null },
        venue: { status: VenueStatus.approved, archivedAt: null, billingPaused: false, moderationStatus: 'none', owner: { status: UserStatus.active } },
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
      where: { id, status: VenueStatus.approved, archivedAt: null, billingPaused: false, moderationStatus: 'none', owner: { status: UserStatus.active } },
      include: {
        courts: { where: { isActive: true, status: 'approved' }, orderBy: { pricePerHour: 'asc' } },
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
