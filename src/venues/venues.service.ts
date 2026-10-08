import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, VenueStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { QueryVenuesDto } from './dto';

@Injectable()
export class VenuesService {
  constructor(private prisma: PrismaService) {}

  // Public listing — only approved venues are visible to players.
  async list(query: QueryVenuesDto) {
    const { q, city, sport, page = 1, limit = 20 } = query;
    const where: Prisma.VenueWhereInput = { status: VenueStatus.approved };
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
        },
        orderBy: { rating: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { total, page, limit, data };
  }

  async getById(id: string) {
    const venue = await this.prisma.venue.findFirst({
      where: { id, status: VenueStatus.approved },
      include: {
        courts: { where: { isActive: true }, orderBy: { pricePerHour: 'asc' } },
        badges: { include: { badge: true }, orderBy: { badge: { tier: 'desc' } } },
      },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    return venue;
  }
}
