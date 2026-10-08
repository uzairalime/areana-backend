import { Injectable } from '@nestjs/common';
import { VenueStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { AvailabilityService } from '../availability/availability.service';
import { parseDateOnly } from '../common/date.util';

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
  ) {}

  async slotSearch(q: SlotSearchQuery) {
    parseDateOnly(q.date); // validates format
    const venues = await this.prisma.venue.findMany({
      where: {
        status: VenueStatus.approved,
        ...(q.city ? { city: { equals: q.city, mode: 'insensitive' } } : {}),
        courts: {
          some: {
            isActive: true,
            ...(q.sport ? { sport: { equals: q.sport, mode: 'insensitive' } } : {}),
            ...(q.size ? { size: q.size } : {}),
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
        courts: {
          where: {
            isActive: true,
            ...(q.sport ? { sport: { equals: q.sport, mode: 'insensitive' } } : {}),
            ...(q.size ? { size: q.size } : {}),
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
      take: 50,
    });

    const results: any[] = [];
    for (const venue of venues) {
      const courts: any[] = [];
      for (const court of venue.courts) {
        const avail = await this.availability.getAvailability(court.id, q.date);
        const free = avail.slots.filter((s) => s.available);
        if (free.length > 0) {
          courts.push({ ...court, pricePerHour: Number(court.pricePerHour), availableSlots: free });
        }
      }
      if (courts.length > 0) {
        const { courts: _c, ...v } = venue;
        results.push({ venue: v, courts });
      }
    }
    // Best availability first.
    results.sort(
      (a, b) =>
        b.courts.reduce((s: number, c: any) => s + c.availableSlots.length, 0) -
        a.courts.reduce((s: number, c: any) => s + c.availableSlots.length, 0),
    );
    return { date: q.date, results };
  }
}
