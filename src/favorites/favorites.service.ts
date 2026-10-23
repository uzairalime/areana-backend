import { Injectable, NotFoundException } from '@nestjs/common';
import { UserStatus, VenueStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { cursorPage, keysetWhere, pageLimit } from '../common/pagination';

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
  constructor(private prisma: PrismaService) {}

  async list(userId: string, cursor?: string, rawLimit?: number) {
    const limit = pageLimit(rawLimit, 30);
    const rows = await this.prisma.favorite.findMany({
      // Paused venues (owner suspended) disappear from favorites too.
      where: {
        userId,
        venue: { status: VenueStatus.approved, archivedAt: null, billingPaused: false, moderationStatus: 'none', owner: { status: UserStatus.active } },
        ...keysetWhere(cursor, 'createdAt', 'desc', 'venueId'),
      },
      include: { venue: { select: venueSummary } },
      orderBy: [{ createdAt: 'desc' }, { venueId: 'desc' }],
      take: limit + 1,
    });
    return cursorPage(rows, limit, (r) => r.createdAt, undefined, (r) => r.venueId);
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
