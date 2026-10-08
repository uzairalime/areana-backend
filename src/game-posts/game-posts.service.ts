import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { AuthUser } from '../common/auth';
import {
  isSameDay,
  minutesSinceMidnight,
  parseDateOnly,
  startOfToday,
} from '../common/date.util';
import { CreateGamePostDto, GamePostQueryDto, JoinGamePostDto } from './dto';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class GamePostsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  list(query: GamePostQueryDto) {
    const where: Prisma.GamePostWhereInput = { status: 'open' };
    if (query.sport) where.sport = { equals: query.sport, mode: 'insensitive' };
    if (query.city) where.city = { equals: query.city, mode: 'insensitive' };
    where.date = query.date ? parseDateOnly(query.date) : { gte: startOfToday() };

    return this.prisma.gamePost.findMany({
      where,
      include: {
        creator: { select: { name: true } },
        venue: { select: { id: true, name: true, address: true, city: true } },
        _count: { select: { participants: true } },
      },
      orderBy: [{ isCurated: 'desc' }, { date: 'asc' }, { startMinutes: 'asc' }],
    });
  }

  create(userId: string, dto: CreateGamePostDto) {
    return this.prisma.gamePost.create({
      data: {
        creatorId: userId,
        sport: dto.sport,
        city: dto.city,
        venueId: dto.venueId,
        date: parseDateOnly(dto.date),
        startMinutes: dto.startMinutes,
        playersNeeded: dto.playersNeeded,
        note: dto.note,
      },
    });
  }

  async join(postId: string, user: AuthUser, dto: JoinGamePostDto) {
    const post = await this.prisma.gamePost.findUnique({
      where: { id: postId },
      include: { _count: { select: { participants: true } } },
    });
    if (!post) throw new NotFoundException('Game not found');
    if (post.status !== 'open') throw new BadRequestException('This game is no longer open');

    const now = new Date();
    if (
      post.date < startOfToday() ||
      (isSameDay(post.date, now) && post.startMinutes <= minutesSinceMidnight(now))
    ) {
      throw new BadRequestException('This game has already started');
    }

    const existing = await this.prisma.gameParticipant.findFirst({
      where: { postId, userId: user.id },
    });
    if (existing) throw new ConflictException('You have already joined this game');
    if (post._count.participants >= post.playersNeeded) {
      throw new ConflictException('This game is full');
    }

    const me = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { name: true, phone: true },
    });
    const participant = await this.prisma.gameParticipant.create({
      data: {
        postId,
        userId: user.id,
        name: dto.name || me?.name || 'Player',
        phone: dto.phone || me?.phone,
      },
    });

    if (post._count.participants + 1 >= post.playersNeeded) {
      await this.prisma.gamePost.update({
        where: { id: postId },
        data: { status: 'full' },
      });
    }

    // Notify the game creator (not when they join their own game).
    if (post.creatorId !== user.id) {
      await this.notifications
        .notifyGameJoin(post.creatorId, participant.name, post.sport)
        .catch(() => {});
    }
    return participant;
  }

  async leave(postId: string, userId: string) {
    const participant = await this.prisma.gameParticipant.findFirst({
      where: { postId, userId },
    });
    if (!participant) throw new NotFoundException('You have not joined this game');
    await this.prisma.gameParticipant.delete({ where: { id: participant.id } });
    // Reopen the game if it had filled up.
    await this.prisma.gamePost.updateMany({
      where: { id: postId, status: 'full' },
      data: { status: 'open' },
    });
    return { message: 'Left the game' };
  }

  async remove(postId: string, userId: string) {
    const post = await this.prisma.gamePost.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException('Game not found');
    if (post.creatorId !== userId) {
      throw new ForbiddenException('Only the creator can delete this game');
    }
    await this.prisma.gamePost.delete({ where: { id: postId } });
    return { message: 'Game deleted' };
  }
}
