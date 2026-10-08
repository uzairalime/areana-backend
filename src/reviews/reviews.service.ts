import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma';
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

    return this.prisma.$transaction(async (tx) => {
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
  }

  listByVenue(venueId: string) {
    return this.prisma.review.findMany({
      where: { venueId },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
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
