import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserStatus, VenueStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { AvailabilityService } from '../availability/availability.service';
import {
  isSameDay,
  minutesSinceMidnight,
  parseDateOnly,
  startOfToday,
} from '../common/date.util';
import { JoinWaitlistDto } from './dto';

const MAX_ACTIVE = 10;

@Injectable()
export class WaitlistService {
  constructor(
    private prisma: PrismaService,
    private availability: AvailabilityService,
  ) {}

  /** Join the waitlist for a slot that is currently taken. */
  async join(userId: string, dto: JoinWaitlistDto) {
    const court = await this.prisma.court.findFirst({
      where: {
        id: dto.courtId,
        isActive: true,
        status: 'approved',
        venue: {
          status: VenueStatus.approved,
          archivedAt: null,
          billingPaused: false,
          moderationStatus: 'none',
          owner: { status: UserStatus.active },
        },
      },
      select: { id: true },
    });
    if (!court) throw new NotFoundException('Court not found');

    const date = parseDateOnly(dto.date);
    const now = new Date();
    if (
      date < startOfToday() ||
      (isSameDay(date, now) && dto.startMinutes <= minutesSinceMidnight(now))
    ) {
      throw new BadRequestException('That slot has already passed');
    }

    const active = await this.prisma.slotWaitlist.count({
      where: { userId, notifiedAt: null, date: { gte: startOfToday() } },
    });
    if (active >= MAX_ACTIVE) {
      throw new BadRequestException(
        `You're already waiting on ${MAX_ACTIVE} slots — remove one first`,
      );
    }

    // The slot must exist on the day's grid and actually be taken.
    const avail = await this.availability.getAvailability(dto.courtId, dto.date);
    const slot = avail.slots.find((s) => s.startMinutes === dto.startMinutes);
    if (!slot) throw new BadRequestException('No such slot on that day');
    if (slot.available) {
      throw new BadRequestException('That slot is open — you can book it now');
    }

    try {
      return await this.prisma.slotWaitlist.create({
        data: {
          userId,
          courtId: dto.courtId,
          date,
          startMinutes: dto.startMinutes,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException("You're already waiting on this slot");
      }
      throw e;
    }
  }

  listMine(userId: string) {
    return this.prisma.slotWaitlist.findMany({
      where: { userId, date: { gte: startOfToday() } },
      include: {
        court: {
          select: {
            name: true,
            sport: true,
            venue: { select: { id: true, name: true, city: true } },
          },
        },
      },
      orderBy: [{ date: 'asc' }, { startMinutes: 'asc' }],
    });
  }

  async remove(userId: string, id: string) {
    const entry = await this.prisma.slotWaitlist.findFirst({
      where: { id, userId },
    });
    if (!entry) throw new NotFoundException('Waitlist entry not found');
    await this.prisma.slotWaitlist.delete({ where: { id } });
    return { message: 'Removed from the waitlist' };
  }
}
