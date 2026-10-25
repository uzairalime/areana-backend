import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma';
import { cursorPage, keysetWhere, pageLimit } from '../common/pagination';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateReviewDto } from './dto';

@Injectable()
export class ReviewsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

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
    const [total, rows] = await Promise.all([
      this.prisma.review.count({ where: { venueId } }),
      this.prisma.review.findMany({
        where: { venueId, ...keysetWhere(cursor, 'createdAt', 'desc') },
        include: { user: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
    ]);
    // Round 5, R5-18: `total` is the count of ALL reviews for the
    // venue, not just this page — the old cursor page carried no
    // total, so the header could not show "N reviews".
    return cursorPage(rows, limit, undefined, total);
  }

  /** Called by the owner module (ownership is verified there). */
  async replyToReview(reviewId: string, reply: string) {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      include: { venue: { select: { name: true } } },
    });
    if (!review) throw new NotFoundException('Review not found');
    // Round 5, R5-5: reply edits keep history. The previous reply
    // (if any) is appended to ownerReplyHistory as
    // { reply, repliedAt (ISO) } BEFORE ownerReply/repliedAt are
    // overwritten — a first reply leaves history []. The history
    // lives on the Review row itself (ownerReplyHistory JSON column,
    // migration 20261025180000_round5_r5_review_reply_history), not
    // a separate table: replies are few, append-only, and always read
    // with the review.
    const priorHistory: { reply: string; repliedAt: string | null }[] =
      Array.isArray(review.ownerReplyHistory)
        ? (review.ownerReplyHistory as { reply: string; repliedAt: string | null }[])
        : [];
    const history =
      review.ownerReply != null
        ? [
            ...priorHistory,
            {
              reply: review.ownerReply,
              repliedAt: review.repliedAt ? review.repliedAt.toISOString() : null,
            },
          ]
        : priorHistory;
    const updated = await this.prisma.review.update({
      where: { id: reviewId },
      data: { ownerReply: reply, repliedAt: new Date(), ownerReplyHistory: history },
    });
    // Round 5, R5-5: the player hears about the reply (push + email),
    // on first reply AND on edits — previously a reply notified
    // nobody, so the player never knew the arena had responded.
    await this.notifications
      .notifyPlayerEvent(
        review.userId,
        {
          title: 'Arena replied to your review',
          body: `${review.venue.name} replied to your review: "${reply}"`,
          data: { type: 'review_reply', venueId: review.venueId, reviewId },
        },
        `Reply to your review — ${review.venue.name}`,
      )
      .catch(() => {});
    return updated;
  }
}
