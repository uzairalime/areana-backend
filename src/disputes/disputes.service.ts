import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { CreateDisputeDto } from './dto';

export type DisputeAction = 'confirm_no_show' | 'dismiss' | 'credit';

@Injectable()
export class DisputesService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateDisputeDto) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: dto.bookingId, userId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    const open = await this.prisma.dispute.findFirst({
      where: { bookingId: dto.bookingId, status: 'open' },
    });
    if (open) {
      throw new ConflictException('There is already an open dispute for this booking');
    }
    return this.prisma.dispute.create({
      data: { bookingId: booking.id, raisedById: userId, reason: dto.reason },
    });
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
   * `confirm_no_show` also marks the booking and adds a strike to the player.
   */
  async resolveDispute(
    id: string,
    action: DisputeAction,
    resolution: string,
    resolvedById: string,
  ) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id },
      include: { booking: true },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');
    if (dispute.status !== 'open') {
      throw new BadRequestException('Dispute is already resolved');
    }

    return this.prisma.$transaction(async (tx) => {
      if (action === 'confirm_no_show') {
        await tx.booking.update({
          where: { id: dispute.bookingId },
          data: { status: BookingStatus.no_show },
        });
        if (dispute.booking.userId) {
          await tx.user.update({
            where: { id: dispute.booking.userId },
            data: { noShowCount: { increment: 1 } },
          });
        }
      }
      return tx.dispute.update({
        where: { id },
        data: {
          status: action === 'dismiss' ? 'dismissed' : 'resolved',
          resolution,
          resolvedById,
          resolvedAt: new Date(),
        },
      });
    });
  }
}
