import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, UserStatus, VenueStatus } from '@prisma/client';
import { startOfToday } from '../common/date.util';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../common/prisma';
import { BadgesService } from '../badges/badges.service';
import { DisputesService } from '../disputes/disputes.service';
import { SuggestionsService } from '../suggestions/suggestions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
import { CreateRoleDto, CreateUserDto, UpdateRoleDto } from './dto';
import { CreateBadgeDto, UpdateBadgeDto } from '../badges/dto';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private badges: BadgesService,
    private disputes: DisputesService,
    private suggestions: SuggestionsService,
    private notifications: NotificationsService,
    private storage: StorageService,
  ) {}

  private audit(actorId: string, action: string, entity: string, entityId: string) {
    return this.prisma.auditLog.create({ data: { actorId, action, entity, entityId } });
  }

  // ---------------------------------------------------------------- users
  async listUsers(q?: string, roleName?: string, status?: string) {
    return this.prisma.user.findMany({
      where: {
        ...(q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } : {}),
        ...(roleName ? { role: { name: roleName } } : {}),
        ...(status ? { status: status as UserStatus } : {}),
      },
      include: { role: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const { passwordHash: _p, ...safe } = user;
    return safe;
  }

  async createUser(actorId: string, dto: CreateUserDto) {
    const email = dto.email.toLowerCase().trim();
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException('Email already registered');
    const role = await this.prisma.role.findUnique({ where: { id: dto.roleId } });
    if (!role) throw new NotFoundException('Role not found');
    const user = await this.prisma.user.create({
      data: {
        email,
        name: dto.name,
        phone: dto.phone,
        passwordHash: dto.password ? await bcrypt.hash(dto.password, 10) : undefined,
        roleId: role.id,
        status: UserStatus.active,
      },
    });
    await this.audit(actorId, 'user.create', 'user', user.id);
    const { passwordHash: _p, ...safe } = user;
    return safe;
  }

  async setUserRole(actorId: string, id: string, roleId: string) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');
    const user = await this.prisma.user.update({ where: { id }, data: { roleId } });
    await this.audit(actorId, 'user.set_role', 'user', id);
    const { passwordHash: _p, ...safe } = user;
    return safe;
  }

  async setUserStatus(actorId: string, id: string, status: UserStatus) {
    const target = await this.prisma.user.findUnique({
      where: { id },
      include: { role: { select: { name: true } } },
    });
    if (!target) throw new NotFoundException('User not found');
    if (status === UserStatus.suspended) {
      // Nobody locks the platform out of its own admin panel.
      if (id === actorId) {
        throw new BadRequestException("You can't suspend your own account");
      }
      if (target.role.name === 'super_admin') {
        const others = await this.prisma.user.count({
          where: {
            id: { not: id },
            status: UserStatus.active,
            role: { name: 'super_admin' },
          },
        });
        if (others === 0) {
          throw new BadRequestException(
            "You can't suspend the last active super admin",
          );
        }
      }
    }
    const user = await this.prisma.user.update({ where: { id }, data: { status } });
    await this.audit(actorId, `user.${status}`, 'user', id);
    // Suspending a PLAYER cancels their upcoming bookings and tells both
    // sides (owners keep their existing bookings under the round-3
    // policy instead — their venues pause, nothing is cancelled).
    if (status === UserStatus.suspended && target.role.name === 'player') {
      const today = startOfToday();
      const future = await this.prisma.booking.findMany({
        where: {
          userId: id,
          date: { gte: today },
          status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
        },
        include: {
          venue: { select: { name: true, owner: { select: { email: true } } } },
        },
      });
      for (const b of future) {
        await this.prisma.booking.update({
          where: { id: b.id },
          data: { status: BookingStatus.cancelled },
        });
        // A linked game post dies with its booking; tell its squad.
        const post = await this.prisma.gamePost.findUnique({
          where: { bookingId: b.id },
        });
        if (post) {
          const squad = await this.prisma.gameParticipant.findMany({
            where: { postId: post.id, userId: { not: null } },
            select: { userId: true },
          });
          for (const s of squad) {
            await this.notifications
              .pushToUser(s.userId!, {
                title: 'Game cancelled',
                body: "The host's account was suspended, so this game is off.",
                data: { type: 'game_cancelled' },
              })
              .catch(() => {});
          }
          await this.prisma.gamePost.delete({ where: { id: post.id } });
        }
        // Freed slots: ping the waitlist for every slot in the range.
        const freedCourt = await this.prisma.court.findUnique({
          where: { id: b.courtId },
          select: { slotMinutes: true },
        });
        const step = freedCourt?.slotMinutes ?? 60;
        for (let s = b.startMinutes; s < b.endMinutes; s += step) {
          const waiting = await this.prisma.slotWaitlist.findMany({
            where: {
              courtId: b.courtId,
              date: b.date,
              startMinutes: s,
              notifiedAt: null,
            },
          });
          for (const w of waiting) {
            await this.notifications
              .pushToUser(w.userId, {
                title: 'A slot just opened up',
                body: `A slot you were waiting on is free again on ${b.date.toISOString().slice(0, 10)} — first come, first served.`,
                data: { type: 'slot_opened' },
              })
              .catch(() => {});
          }
          if (waiting.length > 0) {
            await this.prisma.slotWaitlist.updateMany({
              where: { id: { in: waiting.map((w) => w.id) } },
              data: { notifiedAt: new Date() },
            });
          }
        }
        if (b.venue.owner?.email) {
          await this.notifications
            .notifyOwnerNewBooking(
              b.venue.owner.email,
              b.venue.name,
              `A booking on ${b.date.toISOString().slice(0, 10)} was cancelled because the player's account was suspended.`,
            )
            .catch(() => {});
        }
      }
      await this.notifications
        .pushToUser(id, {
          title: 'Account suspended',
          body:
            future.length > 0
              ? `Your Areana account has been suspended and your ${future.length} upcoming booking${future.length === 1 ? ' was' : 's were'} cancelled.`
              : 'Your Areana account has been suspended.',
          data: { type: 'account_suspended' },
        })
        .catch(() => {});
      // Pull them out of everyone else's games as well.
      const participations = await this.prisma.gameParticipant.findMany({
        where: { userId: id },
        include: {
          post: { select: { id: true, creatorId: true, sport: true, status: true } },
        },
      });
      if (participations.length > 0) {
        await this.prisma.gameParticipant.deleteMany({ where: { userId: id } });
        const hosts = new Map<string, string>();
        for (const row of participations) {
          if (row.status === 'joined' && row.post.creatorId !== id) {
            hosts.set(row.post.creatorId, row.post.sport);
            if (row.post.status === 'full') {
              await this.prisma.gamePost.update({
                where: { id: row.post.id },
                data: { status: 'open' },
              });
            }
          }
        }
        for (const [hostId, sport] of hosts) {
          await this.notifications
            .pushToUser(hostId, {
              title: 'Squad update',
              body: `A player left your ${sport} game — their spot is open again.`,
              data: { type: 'game_roster_changed' },
            })
            .catch(() => {});
        }
      }
      await this.prisma.refreshSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { id: user.id, status: user.status };
  }

  async resetStrikes(actorId: string, id: string) {
    const user = await this.prisma.user.update({
      where: { id },
      data: { noShowCount: 0, status: UserStatus.active },
    });
    await this.audit(actorId, 'user.reset_strikes', 'user', id);
    return { id: user.id, noShowCount: 0 };
  }

  // ---------------------------------------------------------------- roles
  listRoles() {
    return this.prisma.role.findMany({
      include: { _count: { select: { users: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async createRole(actorId: string, dto: CreateRoleDto) {
    const exists = await this.prisma.role.findUnique({ where: { name: dto.name } });
    if (exists) throw new ConflictException('Role name taken');
    const role = await this.prisma.role.create({ data: { ...dto, scope: dto.scope as any } });
    await this.audit(actorId, 'role.create', 'role', role.id);
    return role;
  }

  async updateRole(actorId: string, id: string, dto: UpdateRoleDto) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.name === 'super_admin') throw new ForbiddenException('Cannot edit the super_admin role');
    const updated = await this.prisma.role.update({ where: { id }, data: dto });
    await this.audit(actorId, 'role.update', 'role', id);
    return updated;
  }

  async deleteRole(actorId: string, id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: { _count: { select: { users: true } } },
    });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) throw new ForbiddenException('System roles cannot be deleted');
    if (role._count.users > 0) throw new BadRequestException('Role still has users assigned');
    await this.prisma.role.delete({ where: { id } });
    await this.audit(actorId, 'role.delete', 'role', id);
    return { deleted: true };
  }

  // -------------------------------------------------------- owners & venues
  /** Owner accounts waiting for approval. */
  pendingOwners() {
    return this.prisma.user.findMany({
      where: { status: UserStatus.pending, role: { name: 'owner' } },
      include: { role: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  pendingVenues() {
    return this.prisma.venue.findMany({
      where: { status: VenueStatus.pending },
      include: { owner: { select: { name: true, email: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveVenue(actorId: string, venueId: string) {
    const venue = await this.prisma.venue.update({
      where: { id: venueId },
      data: { status: VenueStatus.approved },
    });
    await this.audit(actorId, 'venue.approve', 'venue', venueId);
    return venue;
  }

  async rejectVenue(actorId: string, venueId: string) {
    const venue = await this.prisma.venue.update({
      where: { id: venueId },
      data: { status: VenueStatus.rejected },
    });
    await this.audit(actorId, 'venue.reject', 'venue', venueId);
    return venue;
  }

  async suspendVenue(actorId: string, venueId: string) {
    const venue = await this.prisma.venue.update({
      where: { id: venueId },
      data: { status: VenueStatus.suspended },
    });
    await this.audit(actorId, 'venue.suspend', 'venue', venueId);
    return venue;
  }

  /** Per-arena staff governance: which roles this arena's owner may hand out. */
  async setVenueStaffRoles(actorId: string, venueId: string, roleIds: string[]) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    const roles = await this.prisma.role.findMany({ where: { id: { in: roleIds } } });
    if (roles.length !== roleIds.length) throw new BadRequestException('Unknown role id');
    if (roles.some((r) => r.scope !== 'arena' || r.name === 'owner')) {
      throw new BadRequestException('Only arena-scope staff roles can be enabled');
    }
    await this.prisma.$transaction([
      this.prisma.venueAllowedRole.deleteMany({ where: { venueId } }),
      this.prisma.venueAllowedRole.createMany({
        data: roleIds.map((roleId) => ({ venueId, roleId })),
      }),
    ]);
    await this.audit(actorId, 'venue.set_staff_roles', 'venue', venueId);
    return { venueId, roleIds };
  }

  // ---------------------------------------------------------------- promos
  listPromos() {
    return this.prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async createPromo(actorId: string, dto: any) {
    if (dto.kind === 'percent' && (dto.value < 1 || dto.value > 100)) {
      throw new BadRequestException('Percent promo value must be between 1 and 100');
    }
    if (dto.kind === 'flat' && dto.value < 1) {
      throw new BadRequestException('Flat promo value must be at least Rs 1');
    }
    const code = (dto.code ?? `PROMO-${Math.random().toString(36).slice(2, 8).toUpperCase()}`).toUpperCase();
    const promo = await this.prisma.promoCode.create({
      data: {
        code,
        kind: dto.kind,
        value: dto.value,
        maxDiscount: dto.maxDiscount,
        maxUses: dto.maxUses,
        perUserLimit: dto.perUserLimit ?? 1,
        validTo: new Date(dto.validTo),
        isActive: dto.isActive ?? true,
      },
    });
    await this.audit(actorId, 'promo.create', 'promo', promo.id);
    return promo;
  }

  async updatePromo(actorId: string, id: string, dto: { isActive?: boolean }) {
    const promo = await this.prisma.promoCode.update({ where: { id }, data: dto });
    await this.audit(actorId, 'promo.update', 'promo', id);
    return promo;
  }

  // ---------------------------------------------------------------- badges
  listBadges() {
    return this.badges.listBadges();
  }
  createBadge(actorId: string, dto: CreateBadgeDto) {
    return this.badges.createBadge(dto).then(async (b) => {
      await this.audit(actorId, 'badge.create', 'badge', b.id);
      return b;
    });
  }
  updateBadge(actorId: string, id: string, dto: UpdateBadgeDto) {
    return this.badges.updateBadge(id, dto).then(async (b) => {
      await this.audit(actorId, 'badge.update', 'badge', id);
      return b;
    });
  }
  deleteBadge(actorId: string, id: string) {
    return this.badges.deleteBadge(id).then(async () => {
      await this.audit(actorId, 'badge.delete', 'badge', id);
      return { deleted: true };
    });
  }
  grantVenueBadge(actorId: string, venueId: string, badgeId: string) {
    return this.badges.grantBadge(venueId, badgeId, actorId).then(async () => {
      await this.audit(actorId, 'venue.grant_badge', 'venue', venueId);
      return { venueId, badgeId };
    });
  }
  revokeVenueBadge(actorId: string, venueId: string, badgeId: string) {
    return this.badges.revokeBadge(venueId, badgeId).then(async () => {
      await this.audit(actorId, 'venue.revoke_badge', 'venue', venueId);
      return { revoked: true };
    });
  }

  // --------------------------------------------------------------- disputes
  listDisputes(status?: string) {
    return this.prisma.dispute.findMany({
      where: status ? { status } : {},
      include: {
        booking: { include: { venue: { select: { name: true } } } },
        raisedBy: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  resolveDispute(actorId: string, id: string, action: 'confirm_no_show' | 'dismiss' | 'credit', resolution?: string) {
    return this.disputes.resolveDispute(id, action, resolution ?? '', actorId).then(async (d) => {
      await this.audit(actorId, 'dispute.resolve', 'dispute', id);
      return d;
    });
  }

  // ----------------------------------------------------------------- audit
  auditLogs(entity?: string, take = 100) {
    return this.prisma.auditLog.findMany({
      where: entity ? { entity } : {},
      include: { actor: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  // ------------------------------------------------------------- broadcast
  /**
   * Broadcast reach, honestly: `audience` is every active player, but a
   * push only lands on players who have a device token (the app) —
   * `reachable` counts exactly those.
   */
  async broadcastAudience(city?: string) {
    const playerWhere = {
      status: UserStatus.active,
      role: { name: 'player' },
      ...(city
        ? { city: { equals: city, mode: 'insensitive' as const } }
        : {}),
    };
    const audience = await this.prisma.user.count({ where: playerWhere });
    const tokenRows = await this.prisma.deviceToken.findMany({
      where: { user: playerWhere },
      select: { userId: true },
      distinct: ['userId'],
    });
    return { audience, reachable: tokenRows.length };
  }

  async sendBroadcast(actorId: string, title: string, body: string, city?: string) {
    const targeted = await this.notifications.broadcastPush({ title, body }, city);
    await this.audit(actorId, 'broadcast.send', 'broadcast', city ?? 'all');
    return { targeted };
  }

  listBanners() {
    return this.prisma.banner.findMany({ orderBy: { createdAt: 'desc' } });
  }

  /** Process + store a banner image (same pipeline as venue photos). */
  async uploadBannerImage(file: Express.Multer.File) {
    return this.storage.saveBannerImage(file);
  }

  async createBanner(actorId: string, dto: any) {
    const banner = await this.prisma.banner.create({
      data: {
        title: dto.title,
        imageUrl: dto.imageUrl,
        blurhash: dto.blurhash ?? null,
        linkUrl: dto.linkUrl,
        city: dto.city,
        isActive: dto.isActive ?? true,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
      },
    });
    await this.audit(actorId, 'banner.create', 'banner', banner.id);
    return banner;
  }

  async updateBanner(actorId: string, id: string, dto: any) {
    const data: any = { ...dto };
    if (dto.endsAt) data.endsAt = new Date(dto.endsAt);
    const banner = await this.prisma.banner.update({ where: { id }, data });
    await this.audit(actorId, 'banner.update', 'banner', id);
    return banner;
  }

  async deleteBanner(actorId: string, id: string) {
    await this.prisma.banner.delete({ where: { id } });
    await this.audit(actorId, 'banner.delete', 'banner', id);
    return { deleted: true };
  }

  // ------------------------------------------------------------ suggestions
  listSuggestions(status?: string) {
    return this.suggestions.listSuggestions(status);
  }

  setSuggestionStatus(actorId: string, id: string, status: string) {
    return this.suggestions.setStatus(id, status).then(async (s) => {
      await this.audit(actorId, 'suggestion.status', 'suggestion', id);
      return s;
    });
  }

  // ------------------------------------------------------------- game posts
  async curateGamePost(actorId: string, id: string) {
    const post = await this.prisma.gamePost.update({
      where: { id },
      data: { isCurated: true, curatedById: actorId },
    });
    await this.audit(actorId, 'game_post.curate', 'game_post', id);
    return post;
  }

  async uncurateGamePost(actorId: string, id: string) {
    const post = await this.prisma.gamePost.update({
      where: { id },
      data: { isCurated: false, curatedById: null },
    });
    await this.audit(actorId, 'game_post.uncurate', 'game_post', id);
    return post;
  }

  async deleteGamePost(actorId: string, id: string) {
    await this.prisma.gamePost.delete({ where: { id } });
    await this.audit(actorId, 'game_post.delete', 'game_post', id);
    return { deleted: true };
  }

  async deleteReview(actorId: string, id: string) {
    const review = await this.prisma.review.findUnique({ where: { id } });
    if (!review) throw new NotFoundException('Review not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.review.delete({ where: { id } });
      const agg = await tx.review.aggregate({
        where: { venueId: review.venueId },
        _avg: { rating: true },
        _count: true,
      });
      await tx.venue.update({
        where: { id: review.venueId },
        data: { rating: agg._avg.rating ?? 0, ratingCount: agg._count },
      });
    });
    await this.audit(actorId, 'review.delete', 'review', id);
    return { deleted: true };
  }

  // ----------------------------------------------------- booking support ops
  async getBooking(id: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: {
        court: { select: { name: true } },
        venue: { select: { name: true } },
        user: { select: { name: true, email: true, phone: true } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }

  async cancelBooking(actorId: string, id: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException('Booking not found');
    const updated = await this.prisma.booking.update({
      where: { id },
      data: { status: BookingStatus.cancelled },
    });
    await this.audit(actorId, 'booking.cancel', 'booking', id);
    return updated;
  }

  async forceConfirmBooking(actorId: string, id: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException('Booking not found');
    const updated = await this.prisma.booking.update({
      where: { id },
      data: { status: BookingStatus.confirmed },
    });
    await this.audit(actorId, 'booking.force_confirm', 'booking', id);
    return updated;
  }

  // --------------------------------------------------------------- settings
  getSettings() {
    return this.prisma.setting.findMany();
  }

  async updateSettings(actorId: string, settings: Record<string, string>) {
    for (const [key, value] of Object.entries(settings)) {
      await this.prisma.setting.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) },
      });
    }
    await this.audit(actorId, 'settings.update', 'settings', Object.keys(settings).join(','));
    return this.getSettings();
  }
}
