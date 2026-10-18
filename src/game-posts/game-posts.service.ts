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
import { CreateGamePostDto, GamePostQueryDto, UpdateGamePostDto } from './dto';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class GamePostsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  /**
   * Money view of a post, from its linked booking: the net court fee and
   * each player's share of it. Joining players must see this BEFORE they
   * join — nobody should discover at the venue that they owe money.
   * Curated posts have no booking, so both fields are null there.
   */
  private priceView(post: {
    squadSize: number | null;
    playersNeeded: number;
    booking?: { totalPrice: unknown; discountAmount: unknown } | null;
  }): { courtFee: number | null; pricePerPlayer: number | null } {
    if (!post.booking) return { courtFee: null, pricePerPlayer: null };
    const courtFee = Math.max(
      0,
      Number(post.booking.totalPrice) - Number(post.booking.discountAmount),
    );
    // The fee splits across the FULL squad: the host's group (squadSize)
    // plus everyone who joins (playersNeeded). squadSize is always sent
    // by the booking flows; the +1 fallback counts a lone host.
    const squad =
      post.squadSize != null
        ? post.squadSize + post.playersNeeded
        : post.playersNeeded + 1;
    return {
      courtFee,
      pricePerPlayer: squad > 0 ? Math.round(courtFee / squad) : null,
    };
  }

  /** Price view for one post, freshly read (used by notifications). */
  private async priceForPost(postId: string) {
    const post = await this.prisma.gamePost.findUnique({
      where: { id: postId },
      include: {
        booking: { select: { totalPrice: true, discountAmount: true } },
        _count: { select: { participants: { where: { status: 'joined' } } } },
      },
    });
    if (!post) return { courtFee: null, pricePerPlayer: null };
    return this.priceView(post);
  }

  async list(query: GamePostQueryDto, userId?: string) {
    const where: Prisma.GamePostWhereInput = { status: 'open' };
    if (query.sport) where.sport = { equals: query.sport, mode: 'insensitive' };
    if (query.city) where.city = { equals: query.city, mode: 'insensitive' };
    // Date filter: future days wholesale; for today, only games that
    // haven't started yet (a 6pm game shouldn't list as open at 9pm).
    const today = startOfToday();
    const nowMin = minutesSinceMidnight();
    if (query.date) {
      const d = parseDateOnly(query.date);
      where.date = d;
      if (isSameDay(d, today)) where.startMinutes = { gt: nowMin };
    } else {
      where.AND = [
        {
          OR: [
            { date: { gt: today } },
            { date: today, startMinutes: { gt: nowMin } },
          ],
        },
      ];
    }

    const posts = await this.prisma.gamePost.findMany({
      where,
      include: {
        creator: { select: { name: true } },
        venue: { select: { id: true, name: true, address: true, city: true } },
        booking: { select: { totalPrice: true, discountAmount: true } },
        _count: { select: { participants: { where: { status: 'joined' } } } },
      },
      orderBy: [{ isCurated: 'desc' }, { date: 'asc' }, { startMinutes: 'asc' }],
    });
    if (!userId || posts.length === 0) {
      return posts.map((post) => {
        const { booking: _booking, ...rest } = post;
        return {
          ...rest,
          ...this.priceView(post),
          joined: false,
          joinState: 'none' as const,
          pendingCount: 0,
        };
      });
    }
    // One query for the requester's participations among these posts —
    // replaces the player web's localStorage joined-tracking.
    const mine = await this.prisma.gameParticipant.findMany({
      where: { userId, postId: { in: posts.map((post) => post.id) } },
      select: { postId: true, status: true },
    });
    const stateByPost = new Map(mine.map((m) => [m.postId, m.status]));
    // Pending-request counts (the host's inbox pressure on their cards).
    const pending = await this.prisma.gameParticipant.groupBy({
      by: ['postId'],
      where: { postId: { in: posts.map((post) => post.id) }, status: 'pending' },
      _count: true,
    });
    const pendingByPost = new Map(pending.map((r) => [r.postId, r._count]));
    return posts.map((post) => {
      const state = stateByPost.get(post.id);
      const { booking: _booking, ...rest } = post;
      return {
        ...rest,
        ...this.priceView(post),
        joined: state === 'joined',
        joinState: state === 'joined' ? 'joined' : state === 'pending' ? 'pending' : 'none',
        pendingCount: pendingByPost.get(post.id) ?? 0,
      };
    });
  }

  /** One post with its squad — who is playing, not just how many. */
  async getOne(id: string, userId?: string) {
    const post = await this.prisma.gamePost.findUnique({
      where: { id },
      include: {
        creator: { select: { name: true } },
        venue: { select: { id: true, name: true, address: true, city: true } },
        booking: { select: { totalPrice: true, discountAmount: true } },
        participants: {
          orderBy: { joinedAt: 'asc' },
          select: { id: true, name: true, phone: true, joinedAt: true, userId: true, status: true },
        },
      },
    });
    if (!post) throw new NotFoundException('Game not found');
    const { participants, booking: _booking, ...rest } = post;
    const squad = participants.filter((x) => x.status === 'joined');
    const myRow = userId ? participants.find((x) => x.userId === userId) : undefined;
    // Host decision support: who is asking — reliability at a glance.
    let reliability = new Map<string, { noShowCount: number; gamesPlayed: number }>();
    if (userId === post.creatorId) {
      const pendingUserIds = [
        ...new Set(
          participants
            .filter((x) => x.status === 'pending' && x.userId)
            .map((x) => x.userId!),
        ),
      ];
      if (pendingUserIds.length > 0) {
        const users = await this.prisma.user.findMany({
          where: { id: { in: pendingUserIds } },
          select: { id: true, noShowCount: true },
        });
        const played = await this.prisma.booking.groupBy({
          by: ['userId'],
          where: { userId: { in: pendingUserIds }, status: 'completed' },
          _count: true,
        });
        const playedByUser = new Map(played.map((r) => [r.userId, r._count]));
        reliability = new Map(
          users.map((u) => [
            u.id,
            {
              noShowCount: u.noShowCount,
              gamesPlayed: playedByUser.get(u.id) ?? 0,
            },
          ]),
        );
      }
    }
    return {
      ...rest,
      ...this.priceView(post),
      date: post.date,
      participants: squad.map((x) => ({ name: x.name, joinedAt: x.joinedAt })),
      // Only the host sees who is asking to join.
      pendingRequests:
        userId === post.creatorId
          ? participants
              .filter((x) => x.status === 'pending')
              .map((x) => ({
                id: x.id,
                name: x.name,
                phone: x.phone,
                joinedAt: x.joinedAt,
                noShowCount: x.userId
                  ? (reliability.get(x.userId)?.noShowCount ?? 0)
                  : 0,
                gamesPlayed: x.userId
                  ? (reliability.get(x.userId)?.gamesPlayed ?? 0)
                  : 0,
              }))
          : undefined,
      joined: myRow?.status === 'joined',
      joinState:
        myRow?.status === 'joined'
          ? 'joined'
          : myRow?.status === 'pending'
            ? 'pending'
            : 'none',
      _count: { participants: squad.length },
    };
  }

  /**
   * Players post ONLY from their own confirmed bookings: venue, court,
   * sport, date and start time all derive from the booking, so a post is
   * always a real booked court. Super admins keep a free-form path for
   * curated posts (venue still validated when one is attached).
   */
  async create(user: AuthUser, dto: CreateGamePostDto) {
    if (dto.bookingId) {
      const booking = await this.prisma.booking.findUnique({
        where: { id: dto.bookingId },
        include: {
          venue: { select: { city: true } },
          court: { select: { sport: true } },
        },
      });
      if (!booking || booking.userId !== user.id) {
        throw new NotFoundException('Booking not found');
      }
      if (booking.status !== 'confirmed') {
        throw new BadRequestException(
          'You can find players once this booking is confirmed',
        );
      }
      const now = new Date();
      if (
        booking.date < startOfToday() ||
        (isSameDay(booking.date, now) &&
          booking.startMinutes <= minutesSinceMidnight(now))
      ) {
        throw new BadRequestException('This booking has already started');
      }
      const existing = await this.prisma.gamePost.findUnique({
        where: { bookingId: booking.id },
      });
      if (existing) {
        throw new ConflictException('This booking already has a game post');
      }
      return this.prisma.gamePost.create({
        data: {
          creatorId: user.id,
          bookingId: booking.id,
          venueId: booking.venueId,
          sport: booking.court.sport,
          city: booking.venue.city,
          date: booking.date,
          startMinutes: booking.startMinutes,
          playersNeeded: dto.playersNeeded,
          squadSize: dto.squadSize ?? null,
          note: dto.note,
        },
      });
    }

    if (user.roleName !== 'super_admin') {
      throw new BadRequestException(
        'Games are posted from your bookings — book a court first, then find players from the booking',
      );
    }
    if (!dto.sport || !dto.city || !dto.date || dto.startMinutes === undefined) {
      throw new BadRequestException('sport, city, date and startMinutes are required');
    }
    const date = parseDateOnly(dto.date);
    const now = new Date();
    if (date < startOfToday()) {
      throw new BadRequestException('Game date is in the past');
    }
    if (isSameDay(date, now) && dto.startMinutes <= minutesSinceMidnight(now)) {
      throw new BadRequestException('That start time has already passed today');
    }
    let city = dto.city;
    if (dto.venueId) {
      const venue = await this.prisma.venue.findUnique({
        where: { id: dto.venueId },
        include: { owner: { select: { status: true } } },
      });
      if (!venue || venue.status !== 'approved' || venue.owner.status !== 'active') {
        throw new BadRequestException('That venue is not bookable right now');
      }
      city = venue.city;
    }
    return this.prisma.gamePost.create({
      data: {
        creatorId: user.id,
        sport: dto.sport,
        city,
        venueId: dto.venueId,
        date,
        startMinutes: dto.startMinutes,
        playersNeeded: dto.playersNeeded,
        squadSize: dto.squadSize ?? null,
        note: dto.note,
        isCurated: true,
        curatedById: user.id,
      },
    });
  }

  /** Host edits: squad numbers and note only — time follows the booking. */
  async update(postId: string, userId: string, dto: UpdateGamePostDto) {
    const post = await this.prisma.gamePost.findUnique({
      where: { id: postId },
      include: { _count: { select: { participants: { where: { status: 'joined' } } } } },
    });
    if (!post) throw new NotFoundException('Game not found');
    if (post.creatorId !== userId) {
      throw new ForbiddenException('Only the host can edit this game');
    }
    const joined = post._count.participants;
    if (dto.playersNeeded !== undefined && dto.playersNeeded < joined) {
      throw new BadRequestException(
        `${joined} players have already joined — players needed can't go below that`,
      );
    }
    const needed = dto.playersNeeded ?? post.playersNeeded;
    return this.prisma.gamePost.update({
      where: { id: postId },
      data: {
        ...(dto.playersNeeded !== undefined
          ? { playersNeeded: dto.playersNeeded }
          : {}),
        ...(dto.squadSize !== undefined ? { squadSize: dto.squadSize } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        // Keep open/full honest after the numbers move.
        ...(post.status !== 'closed'
          ? { status: joined >= needed ? 'full' : 'open' }
          : {}),
      },
    });
  }

  async join(postId: string, user: AuthUser) {
    // Transaction + row lock: the count check and the insert must be
    // atomic, otherwise two players racing for the last spot both pass
    // the check and the game overfills.
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "GamePost" WHERE "id" = ${postId} FOR UPDATE`;
      const post = await tx.gamePost.findUnique({
        where: { id: postId },
        include: {
          booking: { select: { totalPrice: true, discountAmount: true } },
          _count: { select: { participants: { where: { status: 'joined' } } } },
        },
      });
      if (!post) throw new NotFoundException('Game not found');
      if (post.creatorId === user.id) {
        throw new BadRequestException("You created this game — you're already hosting it");
      }
      if (post.status !== 'open') {
        throw new BadRequestException('This game is no longer open');
      }
      const now = new Date();
      if (
        post.date < startOfToday() ||
        (isSameDay(post.date, now) && post.startMinutes <= minutesSinceMidnight(now))
      ) {
        throw new BadRequestException('This game has already started');
      }
      const existing = await tx.gameParticipant.findFirst({
        where: { postId, userId: user.id },
      });
      if (existing) {
        throw new ConflictException(
          existing.status === 'pending'
            ? 'You have already asked to join this game'
            : 'You have already joined this game',
        );
      }
      if (post._count.participants >= post.playersNeeded) {
        throw new ConflictException('This game is full');
      }
      // Identity comes from the account, never from the request body —
      // a joiner can't appear in the squad under someone else's name.
      // Joining a player-hosted game is a REQUEST: the host accepts
      // players in, and the row sits 'pending' (no spot) until then.
      // Curated games are the platform's own — instant join, no host
      // is standing by to approve anything.
      if (!post.isCurated) {
        const pendingMine = await tx.gameParticipant.count({
          where: {
            userId: user.id,
            status: 'pending',
            post: { date: { gte: startOfToday() } },
          },
        });
        if (pendingMine >= 10) {
          throw new BadRequestException(
            'You already have 10 join requests waiting — let hosts respond or withdraw some first',
          );
        }
      }
      const me = await tx.user.findUnique({
        where: { id: user.id },
        select: { name: true, phone: true },
      });
      const participant = await tx.gameParticipant.create({
        data: {
          postId,
          userId: user.id,
          name: me?.name || 'Player',
          phone: me?.phone,
          status: post.isCurated ? 'joined' : 'pending',
        },
      });
      if (post.isCurated && post._count.participants + 1 >= post.playersNeeded) {
        await tx.gamePost.update({
          where: { id: postId },
          data: { status: 'full' },
        });
      }
      return { participant, post };
    });

    if (result.post.creatorId !== user.id && result.participant.status === 'pending') {
      const { pricePerPlayer } = this.priceView(result.post);
      await this.notifications
        .notifyGameJoin(result.post.creatorId, result.participant.name, result.post.sport, pricePerPlayer)
        .catch(() => {});
    }
    return result.participant;
  }

  /** Host accepts a pending request into the squad. */
  async acceptRequest(postId: string, hostId: string, participantId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "GamePost" WHERE "id" = ${postId} FOR UPDATE`;
      const post = await tx.gamePost.findUnique({
        where: { id: postId },
        include: {
          _count: { select: { participants: { where: { status: 'joined' } } } },
        },
      });
      if (!post) throw new NotFoundException('Game not found');
      if (post.creatorId !== hostId) {
        throw new ForbiddenException('Only the host can accept players');
      }
      const nowA = new Date();
      if (
        post.date < startOfToday() ||
        (isSameDay(post.date, nowA) && post.startMinutes <= minutesSinceMidnight(nowA))
      ) {
        throw new BadRequestException('This game has already started');
      }
      const row = await tx.gameParticipant.findUnique({
        where: { id: participantId },
      });
      if (!row || row.postId !== postId || row.status !== 'pending') {
        throw new NotFoundException('Request not found');
      }
      if (post._count.participants >= post.playersNeeded) {
        throw new ConflictException('This game is full');
      }
      const accepted = await tx.gameParticipant.update({
        where: { id: participantId },
        data: { status: 'joined' },
      });
      let declined: { userId: string | null; name: string }[] = [];
      if (post._count.participants + 1 >= post.playersNeeded) {
        await tx.gamePost.update({
          where: { id: postId },
          data: { status: 'full' },
        });
        // Squad complete — the remaining requests are declined kindly.
        declined = await tx.gameParticipant.findMany({
          where: { postId, status: 'pending', id: { not: participantId } },
          select: { userId: true, name: true },
        });
        await tx.gameParticipant.deleteMany({
          where: { postId, status: 'pending' },
        });
      }
      return { post, accepted, declined };
    });

    if (result.accepted.userId) {
      const { pricePerPlayer } = await this.priceForPost(postId);
      await this.notifications
        .pushToUser(result.accepted.userId, {
          title: "You're in!",
          body: pricePerPlayer
            ? `The host accepted you into the ${result.post.sport} game. You pay Rs ${pricePerPlayer} at the venue — your share of the court fee.`
            : `The host accepted you into the ${result.post.sport} game. See you on the field.`,
          data: { type: 'game_request_accepted' },
        })
        .catch(() => {});
    }
    for (const d of result.declined) {
      if (!d.userId) continue;
      await this.notifications
        .pushToUser(d.userId, {
          title: 'Game filled up',
          body: `The ${result.post.sport} game filled before the host could accept your request.`,
          data: { type: 'game_request_declined' },
        })
        .catch(() => {});
    }
    return result.accepted;
  }

  /** Host declines a pending request. */
  async rejectRequest(postId: string, hostId: string, participantId: string) {
    const post = await this.prisma.gamePost.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException('Game not found');
    if (post.creatorId !== hostId) {
      throw new ForbiddenException('Only the host can decline players');
    }
    const row = await this.prisma.gameParticipant.findUnique({
      where: { id: participantId },
    });
    if (!row || row.postId !== postId || row.status !== 'pending') {
      throw new NotFoundException('Request not found');
    }
    await this.prisma.gameParticipant.delete({ where: { id: participantId } });
    if (row.userId) {
      await this.notifications
        .pushToUser(row.userId, {
          title: 'Request declined',
          body: `The host couldn't add you to the ${post.sport} game this time.`,
          data: { type: 'game_request_declined' },
        })
        .catch(() => {});
    }
    return { message: 'Request declined' };
  }

  async leave(postId: string, userId: string) {
    const participant = await this.prisma.gameParticipant.findFirst({
      where: { postId, userId },
    });
    if (!participant) throw new NotFoundException('You have not joined this game');
    await this.prisma.gameParticipant.delete({ where: { id: participant.id } });
    // Reopen the game if it had filled up — unless it already started,
    // in which case its status no longer matters.
    const post = await this.prisma.gamePost.findUnique({ where: { id: postId } });
    const started =
      post &&
      (post.date < startOfToday() ||
        (isSameDay(post.date, new Date()) &&
          post.startMinutes <= minutesSinceMidnight()));
    if (!started) {
      await this.prisma.gamePost.updateMany({
        where: { id: postId, status: 'full' },
        data: { status: 'open' },
      });
    }
    return { message: 'Left the game' };
  }

  async remove(postId: string, userId: string) {
    const post = await this.prisma.gamePost.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException('Game not found');
    if (post.creatorId !== userId) {
      throw new ForbiddenException('Only the creator can delete this game');
    }
    // Tell the squad before it vanishes — they may be travelling to it.
    const squad = await this.prisma.gameParticipant.findMany({
      where: { postId, userId: { not: null } },
      select: { userId: true },
    });
    for (const s of squad) {
      await this.notifications
        .pushToUser(s.userId!, {
          title: 'Game cancelled',
          body: `The ${post.sport} game you joined was removed by its host.`,
          data: { type: 'game_cancelled' },
        })
        .catch(() => {});
    }
    await this.prisma.gamePost.delete({ where: { id: postId } });
    return { message: 'Game deleted' };
  }
}
