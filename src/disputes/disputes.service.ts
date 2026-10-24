import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { BookingsService } from '../bookings/bookings.service';
import { CreateDisputeDto } from './dto';

// NOTE: there is deliberately no `credit` action. A credit mechanism
// (wallet / voucher ledger) does not exist, and resolving as "credit"
// while delivering nothing is worse than refusing the action — it is
// future scope, not a quiet no-op.
export type DisputeAction = 'confirm_no_show' | 'dismiss';

@Injectable()
export class DisputesService {
  constructor(
    private prisma: PrismaService,
    private bookings: BookingsService,
  ) {}

  async create(userId: string, dto: CreateDisputeDto) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: dto.bookingId, userId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.status !== 'completed' && booking.status !== 'no_show') {
      throw new BadRequestException(
        'You can only raise a dispute after the game has been played',
      );
    }
    // One dispute per booking, ever: a terminal resolution closes the
    // matter for good (re-raising would refill the admin queue forever).
    const alreadyResolved = await this.prisma.dispute.findFirst({
      where: { bookingId: dto.bookingId, status: { in: ['resolved', 'dismissed'] } },
      select: { id: true },
    });
    if (alreadyResolved) {
      throw new BadRequestException(
        'This booking already has a resolved dispute — it cannot be disputed again',
      );
    }
    const open = await this.prisma.dispute.findFirst({
      where: { bookingId: dto.bookingId, status: 'open' },
    });
    if (open) {
      throw new ConflictException('There is already an open dispute for this booking');
    }
    // openKey is the race guard: two concurrent creates both pass the
    // check above, but only one insert with this key can land.
    try {
      return await this.prisma.dispute.create({
        data: {
          bookingId: booking.id,
          raisedById: userId,
          reason: dto.reason,
          openKey: dto.bookingId,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('There is already an open dispute for this booking');
      }
      throw e;
    }
  }

  listMine(userId: string) {
    return this.prisma.dispute.findMany({
      where: { raisedById: userId },
      include: {
        booking: {
          select: {
            id: true,
            date: true,
            startMinutes: true,
            status: true,
            venue: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Resolves a dispute. Called by the admin module (permissions verified there).
   * `confirm_no_show` also marks the booking and adds a strike to the player —
   * but only on the completed → no_show transition, claimed atomically, with
   * the same strike-limit suspension check as the owner no-show path.
   * The audit row is written inside the same transaction as the resolution.
   */
  async resolveDispute(
    id: string,
    action: DisputeAction,
    resolution: string,
    resolvedById: string,
  ) {
    if (action !== 'confirm_no_show' && action !== 'dismiss') {
      throw new BadRequestException(
        'Unknown dispute action — credit is not supported (no credit mechanism exists)',
      );
    }
    if (!resolution?.trim()) {
      throw new BadRequestException('A resolution note is required');
    }
    const dispute = await this.prisma.dispute.findUnique({
      where: { id },
      include: { booking: true },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');
    if (dispute.status !== 'open') {
      throw new BadRequestException('Dispute is already resolved');
    }
    // Narrowed once, before the transaction: the booking id is a
    // nullable FK (SetNull backstop), and a dispute with no booking
    // cannot be confirmed as a no-show.
    const bookingId = dispute.bookingId;
    const bookingUserId = dispute.booking?.userId ?? null;
    if (action === 'confirm_no_show') {
      if (!bookingId || !dispute.booking) {
        throw new NotFoundException('Dispute has no booking');
      }
      // The owner path (markNoShow) rejects checked-in bookings; the
      // dispute path must not be the back door around it — a player
      // who checked in played the game.
      if (dispute.booking.checkedInAt) {
        throw new BadRequestException('A checked-in booking cannot be confirmed as a no-show');
      }
    }

    let strikeUserId: string | null = null;
    const resolved = await this.prisma.$transaction(async (tx) => {
      if (action === 'confirm_no_show') {
        // Atomic claim: only a completed, not-checked-in booking can
        // become a no-show, and only once — a booking the owner
        // already marked no-show must not earn a second strike from
        // the same game. The checkedInAt condition is the race
        // backstop for the pre-transaction check above.
        const claimed = await tx.booking.updateMany({
          where: { id: bookingId, status: BookingStatus.completed, checkedInAt: null },
          data: { status: BookingStatus.no_show },
        });
        if (claimed.count === 0) {
          throw new BadRequestException(
            'Only a completed booking can be confirmed as a no-show',
          );
        }
        // A no-showed booking must never be resurrected by a stale
        // pending reschedule request.
        await tx.rescheduleRequest.updateMany({
          where: { bookingId, status: 'pending' },
          data: {
            status: 'rejected',
            reason: 'Booking is no longer active',
            decidedAt: new Date(),
          },
        });
        if (bookingUserId) {
          const struck = await tx.user.update({
            where: { id: bookingUserId },
            data: { noShowCount: { increment: 1 } },
          });
          strikeUserId = struck.id;
        }
      }
      const updated = await tx.dispute.update({
        where: { id },
        data: {
          status: action === 'dismiss' ? 'dismissed' : 'resolved',
          resolution: resolution.trim(),
          resolvedById,
          resolvedAt: new Date(),
          openKey: null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: resolvedById,
          action: 'dispute.resolve',
          entity: 'dispute',
          entityId: id,
          details: action,
        },
      });
      return updated;
    });

    // The strike notice goes out for every strike (not just the
    // suspending one), then strike-limit suspension runs after the
    // transaction (it has its own cascade); the strike count itself
    // is already durable above.
    if (strikeUserId) {
      await this.bookings.pushNoShowStrike(strikeUserId);
      const user = await this.prisma.user.findUnique({
        where: { id: strikeUserId },
        select: { status: true, noShowCount: true },
      });
      const limit = parseInt(
        (await this.prisma.setting.findUnique({ where: { key: 'noShowStrikeLimit' } }))?.value ?? '3',
        10,
      );
      if (user && user.status === 'active' && user.noShowCount >= limit) {
        await this.bookings.suspendPlayerWithCascade(strikeUserId);
      }
    }
    return resolved;
  }
}
