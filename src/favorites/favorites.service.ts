import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma';

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
} as const;

@Injectable()
export class FavoritesService {
  constructor(private prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.favorite.findMany({
      where: { userId },
      include: { venue: { select: venueSummary } },
      orderBy: { createdAt: 'desc' },
    });
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
