import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma';
import { cursorPage, keysetWhere, pageLimit } from '../common/pagination';
import { CreateReviewDto } from './dto';

@Injectable()
export class ReviewsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateReviewDto) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: dto.bookingId, userId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.status !== 'completed') {
      throw new BadRequestException('You can only review completed bookings');
    }
    const existing = await this.prisma.review.findUnique({
      where: { bookingId: dto.bookingId },
    });
    if (existing) throw new ConflictException('You already reviewed this booking');

    // The pre-check races a double-tap: two concurrent creates both
    // pass it, and the second used to surface a raw P2002 500. The
    // venue row lock also serializes the aggregate recompute — two
    // simultaneous reviews used to both write count 11 (lost update).
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${booking.venueId} FOR UPDATE`;
        const review = await tx.review.create({
          data: {
            venueId: booking.venueId,
            userId,
            bookingId: booking.id,
            rating: dto.rating,
            comment: dto.comment,
          },
        });
        const agg = await tx.review.aggregate({
          where: { venueId: booking.venueId },
          _avg: { rating: true },
          _count: true,
        });
        await tx.venue.update({
          where: { id: booking.venueId },
          data: {
            rating: agg._avg.rating ?? 0,
            ratingCount: agg._count,
          },
        });
        return review;
      });
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException('You already reviewed this booking');
      }
      throw e;
    }
  }

  async listByVenue(venueId: string, cursor?: string, rawLimit?: number) {
    const limit = pageLimit(rawLimit, 20);
    const rows = await this.prisma.review.findMany({
      where: { venueId, ...keysetWhere(cursor, 'createdAt', 'desc') },
      include: { user: { select: { name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return cursorPage(rows, limit);
  }

  /** Called by the owner module (ownership is verified there). */
  async replyToReview(reviewId: string, reply: string) {
    const review = await this.prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) throw new NotFoundException('Review not found');
    return this.prisma.review.update({
      where: { id: reviewId },
      data: { ownerReply: reply, repliedAt: new Date() },
    });
  }
}
