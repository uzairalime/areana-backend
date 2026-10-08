import { Injectable, NotFoundException } from '@nestjs/common';
import { VenueStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';

@Injectable()
export class CourtsService {
  constructor(private prisma: PrismaService) {}

  // Public: courts of one approved venue.
  async listByVenue(venueId: string) {
    const venue = await this.prisma.venue.findFirst({
      where: { id: venueId, status: VenueStatus.approved },
      select: { id: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    return this.prisma.court.findMany({
      where: { venueId, isActive: true },
      orderBy: { pricePerHour: 'asc' },
    });
  }

  async getActiveCourt(courtId: string) {
    const court = await this.prisma.court.findFirst({
      where: {
        id: courtId,
        isActive: true,
        venue: { status: VenueStatus.approved },
      },
      include: { venue: true },
    });
    if (!court) throw new NotFoundException('Court not found');
    return court;
  }
}
