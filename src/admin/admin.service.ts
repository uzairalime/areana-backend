import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, UserStatus, VenueStatus, type Prisma } from '@prisma/client';
import { startOfToday } from '../common/date.util';
import { decodeCursor, encodeCursor, offsetPage, offsetPageFromDb, pageLimit } from '../common/pagination';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../common/prisma';
import { BadgesService } from '../badges/badges.service';
import { BookingsService } from '../bookings/bookings.service';
import { DisputesService } from '../disputes/disputes.service';
import { SuggestionsService } from '../suggestions/suggestions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
import { PlansService } from '../plans/plans.service';
import type { CreatePlanDto, UpdatePlanDto } from '../plans/dto';
import type { OnboardArenaDto } from './dto';
import {
  assertBookingWindow,
  assertPakistanCoords,
  photoEntriesOf,
  venueReadiness,
  withSportTag,
} from '../venues/venue-readiness';
import { AmenitiesService } from '../amenities/amenities.service';
import { CreateRoleDto, CreateUserDto, UpdateRoleDto } from './dto';
import type { UpdatePromoDto } from './dto';
import { CreateBadgeDto, UpdateBadgeDto } from '../badges/dto';
import { SportsService } from '../sports/sports.service';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private badges: BadgesService,
    private bookings: BookingsService,
    private disputes: DisputesService,
    private suggestions: SuggestionsService,
    private notifications: NotificationsService,
    private storage: StorageService,
    private plans: PlansService,
    private sports: SportsService,
    private amenities: AmenitiesService,
  ) {}

  private audit(
    actorId: string,
    action: string,
    entity: string,
    entityId: string,
    details?: string,
  ) {
    return this.prisma.auditLog.create({
      data: { actorId, action, entity, entityId, details },
    });
  }

  // ---------------------------------------------------------------- users
  /**
   * The role-aware detail screen for /admin/users/:id — account plus,
   * by what the account actually does: player history (bookings, spend,
   * reviews, favorites, disputes, reports, referrals) and staff
   * assignments, with the audit trail both ways.
   */
  async userDetailScreen(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const { passwordHash: _p, ...safeUser } = user;

    const today = new Date(
      `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date())}T00:00:00.000Z`,
    );

    const [
      statusRows,
      upcoming,
      recentBookings,
      reviews,
      reviewCount,
      favorites,
      disputes,
      reportsFiled,
      referralsMade,
      referredBy,
      staffLinks,
      activityOn,
      activityBy,
      gamesHosted,
      gamesJoined,
    ] = await Promise.all([
      this.prisma.booking.groupBy({
        by: ['status'],
        where: { userId: id },
        _count: true,
        _sum: { totalPrice: true, discountAmount: true },
      }),
      this.prisma.booking.count({
        where: { userId: id, status: 'confirmed', date: { gte: today } },
      }),
      this.prisma.booking.findMany({
        where: { userId: id },
        include: {
          venue: { select: { id: true, name: true, city: true } },
          court: { select: { name: true, sport: true } },
        },
        orderBy: [{ date: 'desc' }, { startMinutes: 'desc' }],
        take: 10,
      }),
      this.prisma.review.findMany({
        where: { userId: id },
        include: { venue: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      this.prisma.review.count({ where: { userId: id } }),
      this.prisma.favorite.findMany({
        where: { userId: id },
        include: {
          venue: { select: { id: true, name: true, city: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.dispute.findMany({
        where: { raisedById: id },
        include: {
          booking: {
            select: {
              date: true,
              venue: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      this.prisma.venueReport.count({ where: { userId: id } }),
      this.prisma.referral.count({ where: { referrerId: id } }),
      this.prisma.referral.findUnique({
        where: { refereeId: id },
        include: { referrer: { select: { name: true, email: true } } },
      }),
      this.prisma.venueStaff.findMany({
        where: { userId: id },
        include: {
          venue: {
            select: {
              id: true,
              name: true,
              city: true,
              status: true,
              owner: { select: { name: true, email: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.auditLog.findMany({
        where: { entity: 'user', entityId: id },
        include: { actor: { select: { name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        take: 15,
      }),
      this.prisma.auditLog.findMany({
        where: { actorId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      // Game history: posts the user hosts plus posts they joined.
      this.prisma.gamePost.findMany({
        where: { creatorId: id },
        include: {
          venue: { select: { id: true, name: true } },
          _count: { select: { participants: { where: { status: 'joined' } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      this.prisma.gamePost.findMany({
        where: { participants: { some: { userId: id, status: 'joined' } } },
        include: {
          venue: { select: { id: true, name: true } },
          creator: { select: { name: true } },
          _count: { select: { participants: { where: { status: 'joined' } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
    ]);

    const byStatus = new Map(statusRows.map((r) => [r.status as string, r]));
    const count = (s: string) => byStatus.get(s)?._count ?? 0;
    const spent = (['confirmed', 'completed'] as const).reduce(
      (sum, s) =>
        sum +
        Number(byStatus.get(s)?._sum.totalPrice ?? 0) -
        Number(byStatus.get(s)?._sum.discountAmount ?? 0),
      0,
    );

    const rejected = (await this.rejectedFlags([id])).has(id);
    return {
      user: safeUser,
      rejected,
      player: {
        totals: {
          bookings:
            statusRows.reduce((s, r) => s + r._count, 0) - count('cancelled'),
          upcoming,
          completed: count('completed'),
          cancelled: count('cancelled'),
          noShows: count('no_show'),
          spent,
          reviews: reviewCount,
          favorites: favorites.length,
          disputesOpen: disputes.filter((d) => d.status === 'open').length,
          reportsFiled,
          referralsMade,
        },
        recentBookings,
        reviews,
        favorites,
        disputes,
        gamesHosted,
        gamesJoined,
        referredBy: referredBy
          ? {
              name: referredBy.referrer.name,
              email: referredBy.referrer.email,
              status: referredBy.status,
            }
          : null,
      },
      staff: staffLinks,
      activityOn,
      activityBy,
    };
  }

  /**
   * Accounts whose latest status audit was a signup rejection — they sit
   * in `suspended` like everyone else, but the UI marks them Rejected so
   * they stay distinguishable (and re-approvable) in Users.
   */
  private async rejectedFlags(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const logs = await this.prisma.auditLog.findMany({
      where: {
        entity: 'user',
        entityId: { in: ids },
        action: { in: ['user.reject', 'user.suspended', 'user.active', 'user.pending'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { entityId: true, action: true },
    });
    const latest = new Map<string, string>();
    for (const l of logs) {
      if (!latest.has(l.entityId)) latest.set(l.entityId, l.action);
    }
    return new Set(
      [...latest].filter(([, a]) => a === 'user.reject').map(([id]) => id),
    );
  }

  /** Platform-wide user totals for the Users stat cards. */
  async usersStats() {
    const [total, players, owners, suspended] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: { name: 'player' } } }),
      this.prisma.user.count({ where: { role: { name: 'owner' } } }),
      this.prisma.user.count({ where: { status: UserStatus.suspended } }),
    ]);
    return { total, players, owners, suspended };
  }

  /**
   * Reject a pending signup: suspends the account but audits it as a
   * rejection, so the account stays marked Rejected in Users (with a
   * one-tap re-approval) instead of blending into suspended-for-cause.
   * An optional reason is stored on the account and pushed to the user.
   */
  async rejectUser(actorId: string, id: string, reason?: string) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User not found');
    if (target.status !== UserStatus.pending) {
      throw new BadRequestException('Only a pending signup can be rejected');
    }
    const user = await this.prisma.user.update({
      where: { id },
      data: { status: UserStatus.suspended, rejectionReason: reason?.trim() || null },
    });
    await this.audit(actorId, 'user.reject', 'user', id, reason);
    await this.notifications
      .pushToUser(id, {
        title: 'Your Areana signup was not approved',
        body: reason?.trim()
          ? `Your signup was not approved: ${reason.trim()}`
          : 'Your signup was not approved. Contact support if you think this is a mistake.',
        data: { type: 'account_rejected' },
      })
      .catch(() => {});
    const { passwordHash: _p, ...safe } = user;
    return safe;
  }

  /**
   * Keyset (cursor) pagination helpers. A cursor is
   * `${createdAtISO}|${id}` of the last row of the previous page; the
   * (createdAt, id) pair is unique and stable, so pages never drift when
   * rows are inserted or removed between requests — and a cursor whose
   * row was deleted still works, unlike Prisma's record-based cursor.
   */
  // The codec lives in common/pagination (the shared schema); these
  // adapters keep the (createdAt, id) shape this service's queries use.
  private keyset(cursor?: string): { createdAt: Date; id: string } | null {
    if (cursor) {
      const ks = decodeCursor(cursor);
      if (!ks) throw new BadRequestException('Malformed pagination cursor');
      return { createdAt: ks.date, id: ks.id };
    }
    return null;
  }

  private keysetCursor(row: { createdAt: Date; id: string }): string {
    return encodeCursor(row.createdAt, row.id);
  }

  async listUsers(q?: string, roleName?: string, status?: string, cursor?: string) {
    const ks = this.keyset(cursor);
    const rows = await this.prisma.user.findMany({
      where: {
        ...(roleName ? { role: { name: roleName } } : {}),
        ...(status ? { status: status as UserStatus } : {}),
        AND: [
          ...(q
            ? [
                {
                  OR: [
                    { email: { contains: q, mode: 'insensitive' as const } },
                    { name: { contains: q, mode: 'insensitive' as const } },
                    { phone: { contains: q, mode: 'insensitive' as const } },
                    { city: { contains: q, mode: 'insensitive' as const } },
                  ],
                },
              ]
            : []),
          ...(ks
            ? [
                {
                  OR: [
                    { createdAt: { lt: ks.createdAt } },
                    { createdAt: ks.createdAt, id: { lt: ks.id } },
                  ],
                },
              ]
            : []),
        ],
      },
      include: { role: { select: { name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 101,
    });
    const pageRows = rows.slice(0, 100);
    const rejected = await this.rejectedFlags(pageRows.map((u) => u.id));
    const items = pageRows.map((u) => {
      const { passwordHash: _p, ...safe } = u;
      return { ...safe, rejected: rejected.has(u.id) };
    });
    return {
      items,
      nextCursor: rows.length > 100 ? this.keysetCursor(pageRows[pageRows.length - 1]) : null,
    };
  }

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        role: true,
        // An owner's arenas are the first thing an admin looks for on
        // their profile (and the context for an approval decision).
        venues: {
          select: { id: true, name: true, city: true, status: true },
          orderBy: { createdAt: 'desc' },
        },
      },
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
    if (role.ownerId) {
      throw new BadRequestException(
        "That role belongs to an arena owner — team roles are assigned from the owner's panel, not here.",
      );
    }
    if (role.name !== 'player' && !dto.password) {
      // Owners and staff sign in with a password and there is no
      // set-password flow — a passwordless account could never sign in.
      throw new BadRequestException(
        'Set a password — owners and staff sign in with one, and a passwordless account could never sign in.',
      );
    }
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
    if (id === actorId) {
      throw new BadRequestException("You can't change your own role");
    }
    const target = await this.prisma.user.findUnique({
      where: { id },
      include: { role: { select: { name: true } } },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.role.name === 'super_admin' && role.name !== 'super_admin') {
      const others = await this.prisma.user.count({
        where: {
          id: { not: id },
          status: UserStatus.active,
          role: { name: 'super_admin' },
        },
      });
      if (others === 0) {
        throw new BadRequestException(
          "You can't demote the last active super admin",
        );
      }
    }
    if (role.ownerId) {
      throw new BadRequestException(
        "That role belongs to an arena owner — team roles are assigned from the owner's panel, not here.",
      );
    }
    const user = await this.prisma.user.update({ where: { id }, data: { roleId } });
    await this.audit(actorId, 'user.set_role', 'user', id);
    await this.notifications
      .pushToUser(id, {
        title: 'Your Areana role changed',
        body: `Your account role is now ${role.name}.`,
        data: { type: 'role_changed' },
      })
      .catch(() => {});
    const { passwordHash: _p, ...safe } = user;
    return safe;
  }

  async setUserStatus(actorId: string, id: string, status: UserStatus) {
    const target = await this.prisma.user.findUnique({
      where: { id },
      include: { role: { select: { name: true } } },
    });
    if (!target) throw new NotFoundException('User not found');
    if (status === UserStatus.pending) {
      // Pending is a signup state, not a management state — moving an
      // account back there locks it out and (for players) hides it from
      // every queue. Signups are rejected via the reject flow instead.
      throw new BadRequestException(
        "Accounts can't be moved back to pending — reject the signup or suspend the account instead.",
      );
    }
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
    // Approval/reactivation clears any stored rejection reason, so a
    // stale reason never shows on a live account.
    const user = await this.prisma.user.update({
      where: { id },
      data: status === UserStatus.active ? { status, rejectionReason: null } : { status },
    });
    await this.audit(actorId, `user.${status}`, 'user', id);
    if (status === UserStatus.suspended && target.role.name === 'owner') {
      await this.notifications
        .pushToUser(id, {
          title: 'Your Areana account is suspended',
          body: 'Your arenas are hidden from players while your account is suspended.',
          data: { type: 'account_suspended' },
        })
        .catch(() => {});
    }
    if (status === UserStatus.active && target.status === UserStatus.suspended && target.role.name === 'owner') {
      await this.notifications
        .pushToUser(id, {
          title: 'Your Areana account is active again',
          body: 'You can sign in again. Arenas under moderation or a billing pause stay hidden until those are resolved.',
          data: { type: 'account_unsuspended' },
        })
        .catch(() => {});
      // Billing freeze, second half (S6): the sweep skips suspended
      // owners' venues, so no new pause/reminder fires while hidden —
      // but the wall-clock billing dates still aged. Shift every
      // billed venue's clock forward by the suspension window so the
      // owner isn't instantly overdue for time their arenas were
      // hidden. See forgiveSuspensionBillingWindow.
      await this.forgiveSuspensionBillingWindow(actorId, id);
    }
    if (
      status === UserStatus.active &&
      target.status === UserStatus.pending &&
      target.role.name === 'owner'
    ) {
      await this.notifications
        .pushToUser(id, {
          title: 'Your Areana owner account is approved',
          body: 'You can sign in now and start listing your arenas.',
          data: { type: 'account_approved' },
        })
        .catch(() => {});
    }
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
    if (status === UserStatus.suspended) {
      // A suspended account keeps no push channel: direct pushes and
      // broadcasts both resolve device tokens, and a suspended owner
      // or player must not keep receiving them. This runs LAST on
      // purpose — the suspension notices above are pushed first, and
      // deleting the tokens earlier would have swallowed them.
      // (API access is already blocked per request by the JWT guard;
      // this closes the push side too. Tokens re-register on next
      // sign-in, if the account is ever reactivated.)
      await this.prisma.deviceToken.deleteMany({ where: { userId: id } });
    }
    return { id: user.id, status: user.status };
  }

  /**
   * Billing freeze, second half (S6). While an owner is suspended the
   * sweep skips their venues (see plans.sweepBilling), so no new
   * overdue/pause transition or due reminder fires while the arenas
   * are hidden — but the wall-clock billing dates still aged. On
   * unsuspend, shift every billed venue's clock forward by the
   * suspension window so the owner isn't instantly overdue for time
   * their arenas were hidden. The window is measured from the latest
   * `user.suspended` audit row; if none exists (history pruned, or
   * the status was set outside this path) nothing shifts rather than
   * guessing. The shifted period gets a fresh due reminder (the old
   * period's key is cleared) and the shift itself is audited.
   */
  private async forgiveSuspensionBillingWindow(actorId: string, ownerId: string) {
    const suspendedRow = await this.prisma.auditLog.findFirst({
      where: { entity: 'user', entityId: ownerId, action: 'user.suspended' },
      orderBy: { createdAt: 'desc' },
    });
    if (!suspendedRow) return;
    const ms = Date.now() - suspendedRow.createdAt.getTime();
    if (ms <= 0) return;
    const venues = await this.prisma.venue.findMany({
      where: { ownerId, billingStartAt: { not: null } },
      select: {
        id: true,
        billingStartAt: true,
        billingPaidUntil: true,
        freeUntilOverride: true,
        billingPeriodStart: true,
        billingPeriodEnd: true,
      },
    });
    if (!venues.length) return;
    const shift = (d: Date | null) => (d ? new Date(d.getTime() + ms) : null);
    for (const v of venues) {
      await this.prisma.venue.update({
        where: { id: v.id },
        data: {
          billingStartAt: shift(v.billingStartAt),
          billingPaidUntil: shift(v.billingPaidUntil),
          freeUntilOverride: shift(v.freeUntilOverride),
          billingPeriodStart: shift(v.billingPeriodStart),
          billingPeriodEnd: shift(v.billingPeriodEnd),
          billingDueNotifiedFor: null,
        },
      });
    }
    await this.audit(
      actorId,
      'billing.suspension_forgiven',
      'user',
      ownerId,
      `${venues.length} venue(s) shifted by ${Math.round(ms / 86400000)} day(s)`,
    );
  }

  async resetStrikes(actorId: string, id: string) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('User not found');
    // Strikes only — reactivating a suspended account is a separate,
    // explicit decision (the Unsuspend action), never a side effect.
    const user = await this.prisma.user.update({
      where: { id },
      data: { noShowCount: 0 },
    });
    await this.audit(actorId, 'user.reset_strikes', 'user', id);
    return { id: user.id, noShowCount: 0 };
  }

  /**
   * Admin-initiated password reset. Super admins are out of scope here
   * (their credentials are never reset from the panel) and the target's
   * sessions are revoked, exactly like changePassword does.
   */
  async resetUserPassword(actorId: string, id: string, newPassword: string) {
    const target = await this.prisma.user.findUnique({
      where: { id },
      include: { role: { select: { name: true } } },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.role.name === 'super_admin') {
      throw new ForbiddenException("Super admin passwords can't be reset from the panel");
    }
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10) },
    });
    await this.prisma.refreshSession.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit(actorId, 'user.password_reset', 'user', id);
    await this.notifications
      .pushToUser(id, {
        title: 'Your Areana password was reset',
        body: 'An admin reset your password. Sign in with the new password you were given.',
        data: { type: 'password_reset' },
      })
      .catch(() => {});
    return { id, ok: true };
  }

  // ---------------------------------------------------------------- roles
  listRoles(systemOnly = false) {
    return this.prisma.role.findMany({
      ...(systemOnly ? { where: { ownerId: null } } : {}),
      include: {
        _count: { select: { users: true } },
        owner: { select: { id: true, name: true, email: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  /** Enable/disable an owner-created role. Its permissions immediately
   * stop (or resume) applying to every team member holding it. */
  async setRoleActive(actorId: string, roleId: string, isActive: boolean) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');
    if (!role.ownerId) {
      throw new BadRequestException('Only owner-created roles can be disabled here');
    }
    const updated = await this.prisma.role.update({
      where: { id: roleId },
      data: { isActive },
    });
    await this.audit(actorId, isActive ? 'role.enable' : 'role.disable', 'role', roleId);
    // Everyone holding the role loses (or regains) its permissions at
    // once — tell them, and the role's owner if they aren't a holder.
    const holders = await this.prisma.user.findMany({
      where: { roleId },
      select: { id: true },
    });
    const recipients = new Set(holders.map((h) => h.id));
    if (role.ownerId) recipients.add(role.ownerId);
    for (const userId of recipients) {
      await this.notifications
        .pushToUser(userId, {
          title: isActive ? 'Your team role is active again' : 'Your team role is disabled',
          body: isActive
            ? `The ${role.name} role is active again — its permissions apply to your account.`
            : `The ${role.name} role was disabled by an admin — its permissions no longer apply to your account.`,
          data: { type: 'role_active_changed' },
        })
        .catch(() => {});
    }
    return updated;
  }

  async createRole(actorId: string, dto: CreateRoleDto) {
    const exists = await this.prisma.role.findFirst({ where: { name: dto.name, ownerId: null } });
    if (exists) throw new ConflictException('Role name taken');
    const role = await this.prisma.role.create({ data: { ...dto, scope: dto.scope as any } });
    await this.audit(actorId, 'role.create', 'role', role.id);
    return role;
  }

  async updateRole(actorId: string, id: string, dto: UpdateRoleDto) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.name === 'super_admin') throw new ForbiddenException('Cannot edit the super_admin role');
    // Note: this DTO carries no name field, so admin role renames are
    // not possible here. The system-name guard lives where renames
    // actually happen — owner createMyRole/updateMyRole — because an
    // owner role named 'owner'/'super_admin' would collide with the
    // name-based system-role lookups.
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
  async pendingOwners(cursor?: string) {
    const ks = this.keyset(cursor);
    const baseWhere: Prisma.UserWhereInput = {
      status: UserStatus.pending,
      role: { name: 'owner' },
    };
    const [total, users] = await Promise.all([
      this.prisma.user.count({ where: baseWhere }),
      this.prisma.user.findMany({
        where: ks
          ? {
              ...baseWhere,
              OR: [
                { createdAt: { gt: ks.createdAt } },
                { createdAt: ks.createdAt, id: { gt: ks.id } },
              ],
            }
          : baseWhere,
        include: { role: { select: { name: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 31,
      }),
    ]);
    const pageRows = users.slice(0, 30);
    const out = [];
    for (const u of pageRows) {
      const { passwordHash: _p, ...safe } = u;
      const duplicatePhoneAccounts = u.phone
        ? await this.prisma.user.count({
            where: { phone: u.phone, id: { not: u.id } },
          })
        : 0;
      out.push({ ...safe, duplicatePhoneAccounts });
    }
    return {
      items: out,
      total,
      nextCursor: users.length > 30 ? this.keysetCursor(pageRows[pageRows.length - 1]) : null,
    };
  }

  /**
   * The full owner profile for /admin/owners/:id — account, their arenas
   * (same row shape as the venues directory), team, billing and the
   * audit trail touching the owner or their arenas.
   */
  async ownerDetail(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const { passwordHash: _p, ...safeUser } = user;

    const venues = await this.prisma.venue.findMany({
      where: { ownerId: id },
      include: {
        owner: { select: { id: true, name: true, email: true, phone: true, status: true } },
        plan: true,
        courts: { orderBy: { name: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const venueIds = venues.map((v) => v.id);

    const [bookingRows, countRows, paymentRows, reportRows, staff, activity] =
      await Promise.all([
        this.prisma.booking.groupBy({
          by: ['venueId'],
          where: { venueId: { in: venueIds }, status: { in: ['confirmed', 'completed'] } },
          _count: true,
          _sum: { totalPrice: true, discountAmount: true },
        }),
        this.prisma.booking.groupBy({
          by: ['venueId'],
          where: { venueId: { in: venueIds }, status: { not: 'cancelled' } },
          _count: true,
        }),
        this.prisma.venuePayment.groupBy({
          by: ['venueId'],
          where: { venueId: { in: venueIds } },
          _sum: { amount: true },
        }),
        this.prisma.venueReport.groupBy({
          by: ['venueId'],
          where: { venueId: { in: venueIds }, status: 'open' },
          _count: true,
        }),
        venueIds.length
          ? this.prisma.venueStaff.findMany({
              where: { venueId: { in: venueIds } },
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    status: true,
                    role: { select: { name: true } },
                  },
                },
                venue: { select: { id: true, name: true } },
              },
              orderBy: { createdAt: 'asc' },
            })
          : Promise.resolve([]),
        this.prisma.auditLog.findMany({
          where: {
            OR: [
              { entity: 'user', entityId: id },
              ...(venueIds.length
                ? [{ entity: 'venue', entityId: { in: venueIds } }]
                : []),
            ],
          },
          include: { actor: { select: { name: true, email: true } } },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ]);

    const gmvByVenue = new Map(
      bookingRows.map((r) => [
        r.venueId,
        {
          realized: r._count,
          gmv: Number(r._sum.totalPrice ?? 0) - Number(r._sum.discountAmount ?? 0),
        },
      ]),
    );
    const countByVenue = new Map(countRows.map((r) => [r.venueId, r._count]));
    const revenueByVenue = new Map(
      paymentRows.map((r) => [r.venueId, r._sum.amount ?? 0]),
    );
    const reportsByVenue = new Map(reportRows.map((r) => [r.venueId, r._count]));

    const rows = [];
    for (const v of venues) {
      const g = gmvByVenue.get(v.id) ?? { realized: 0, gmv: 0 };
      rows.push({
        venue: v,
        billing: await this.plans.billingSummary(v),
        readiness: venueReadiness(v, v.courts.filter((c) => c.isActive).length),
        stats: {
          bookings: countByVenue.get(v.id) ?? 0,
          gmv: g.gmv,
          views: 0,
          clicks: 0,
          subscriptionRevenue: revenueByVenue.get(v.id) ?? 0,
          openReports: reportsByVenue.get(v.id) ?? 0,
        },
      });
    }

    const totalReviews = venues.reduce((s, v) => s + v.ratingCount, 0);
    const totals = {
      arenas: venues.length,
      liveArenas: venues.filter((v) => v.status === 'approved').length,
      bookings: rows.reduce((s, r) => s + r.stats.bookings, 0),
      gmv: rows.reduce((s, r) => s + r.stats.gmv, 0),
      subscriptionRevenue: rows.reduce((s, r) => s + r.stats.subscriptionRevenue, 0),
      openReports: rows.reduce((s, r) => s + r.stats.openReports, 0),
      reviews: totalReviews,
      avgRating:
        totalReviews > 0
          ? venues.reduce((s, v) => s + v.rating * v.ratingCount, 0) / totalReviews
          : 0,
      staff: staff.length,
    };

    // Duplicate-account signal: another account on the same phone number.
    const duplicatePhoneAccounts = safeUser.phone
      ? await this.prisma.user.count({
          where: { phone: safeUser.phone, id: { not: id } },
        })
      : 0;

    return {
      user: safeUser,
      rejected: (await this.rejectedFlags([id])).has(id),
      totals,
      venues: rows,
      staff,
      activity,
      duplicatePhoneAccounts,
    };
  }

  async pendingVenues(cursor?: string) {
    const ks = this.keyset(cursor);
    // Archived venues are dead: they must not sit in the queue.
    const baseWhere: Prisma.VenueWhereInput = { status: VenueStatus.pending, archivedAt: null };
    const [total, venues] = await Promise.all([
      this.prisma.venue.count({ where: baseWhere }),
      this.prisma.venue.findMany({
        where: ks
          ? {
              ...baseWhere,
              OR: [
                { createdAt: { gt: ks.createdAt } },
                { createdAt: ks.createdAt, id: { gt: ks.id } },
              ],
            }
          : baseWhere,
        include: {
          owner: { select: { name: true, email: true, phone: true, status: true } },
          // Bookable courts ride along so the approvals card can mirror
          // the venues-list card (court count + sports) without extra
          // calls. Pending courts are not bookable and must not count.
          courts: { where: { isActive: true, status: 'approved' }, select: { id: true, sport: true, status: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 31,
      }),
    ]);
    const pageRows = venues.slice(0, 30);
    return {
      items: pageRows.map((v) => ({
        ...v,
        readiness: venueReadiness(v, v.courts.length),
      })),
      total,
      nextCursor: venues.length > 30 ? this.keysetCursor(pageRows[pageRows.length - 1]) : null,
    };
  }

  async approveVenue(actorId: string, venueId: string) {
    const existing = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!existing) throw new NotFoundException('Venue not found');
    if (existing.status !== VenueStatus.pending && existing.status !== VenueStatus.draft) {
      throw new BadRequestException(
        `This venue is ${existing.status} — only a pending submission can be approved. Refresh the queue.`,
      );
    }
    // Approving past a sanction, an archive, or a billing pause would
    // tell the owner "you're live" while discovery still hides the
    // venue — and start the billing clock on a venue nobody can book.
    if (existing.moderationStatus !== 'none') {
      throw new BadRequestException(
        'This arena is under a platform sanction — lift the sanction before approving',
      );
    }
    if (existing.archivedAt) {
      throw new BadRequestException('This arena is archived — restore it before approving');
    }
    if (existing.billingPaused) {
      throw new BadRequestException('This arena\'s billing is paused — settle billing before approving');
    }
    const owner = await this.prisma.user.findUnique({
      where: { id: existing.ownerId },
      select: { status: true },
    });
    if (!owner || owner.status !== UserStatus.active) {
      throw new BadRequestException(
        "This arena's owner is not active (suspended or awaiting approval) — resolve the owner account first, otherwise the arena goes live with nobody able to manage it and billing running.",
      );
    }
    // Bookable courts only: a venue whose only court is still pending
    // must not be approved into a billed, "live" listing with nothing
    // players can actually book.
    const courts = await this.prisma.court.count({
      where: { venueId, isActive: true, status: 'approved' },
    });
    const readiness = venueReadiness(existing, courts);
    if (!readiness.ready) {
      throw new BadRequestException(
        `This venue isn't ready to go live: ${readiness.missing.join('; ')}`,
      );
    }
    const venue = await this.prisma.venue.update({
      where: { id: venueId },
      data: { status: VenueStatus.approved },
    });
    // First approval starts the plan billing clock (default plan,
    // free period first) — see PlansService.
    await this.plans.startBilling(venueId);
    await this.audit(actorId, 'venue.approve', 'venue', venueId);
    await this.notifications
      .pushToUser(venue.ownerId, {
        title: 'Your arena is approved',
        body: `${venue.name} is live on Areana — players can find it and book its approved courts.`,
        data: { type: 'venue_approved', venueId },
      })
      .catch(() => {});
    return venue;
  }

  // ------------------------------------------------------------- onboarding
  /**
   * Full arena onboarding from the admin panel: creates the owner login,
   * the venue, its courts and (optionally) approves it on a chosen plan.
   * Gated by the 'venues.onboard' permission — super admin (wildcard) or
   * any role the super admin grants it to.
   */
  async onboardArena(actorId: string, dto: OnboardArenaDto) {
    const email = dto.ownerEmail.toLowerCase().trim();
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException('An account with this email already exists');
    // The system owner role, not just any role named 'owner': an owner
    // can create a role with that name, and findFirst order is
    // undefined — picking it would hand a brand-new owner account
    // another owner's permission set.
    const ownerRole = await this.prisma.role.findFirst({ where: { name: 'owner', ownerId: null } });
    if (!ownerRole) {
      throw new BadRequestException('Owner role is missing — run npm run db:seed first');
    }
    if (dto.planId) {
      const plan = await this.prisma.plan.findUnique({ where: { id: dto.planId } });
      if (!plan) throw new NotFoundException('Plan not found');
    }
    const courtNames = (dto.courts ?? []).map((c) => c.name.trim().toLowerCase());
    if (new Set(courtNames).size !== courtNames.length) {
      throw new BadRequestException('Two courts in this onboard have the same name');
    }
    // Onboard courts count against the plan's court cap (the plan that
    // will bill the venue, or the default plan when none is chosen).
    const onboardPlan = dto.planId
      ? await this.prisma.plan.findUnique({ where: { id: dto.planId } })
      : await this.plans.defaultPlan();
    if (onboardPlan?.maxCourts !== null && onboardPlan?.maxCourts !== undefined && (dto.courts ?? []).length > onboardPlan.maxCourts) {
      throw new BadRequestException(
        `This onboard has ${(dto.courts ?? []).length} courts, above the ${onboardPlan.name} plan's limit of ${onboardPlan.maxCourts}`,
      );
    }
    assertPakistanCoords(dto.lat, dto.lng);
    const amenities = await this.amenities.normalizeAmenities(dto.amenities ?? []);
    const courtSports = [...new Set((dto.courts ?? []).map((c) => c.sport))];
    const sports = await this.sports.normalizeSports(
      dto.sports && dto.sports.length > 0 ? dto.sports : courtSports,
    );
    const courtSportByRaw = new Map<string, string>();
    for (const raw of courtSports) {
      courtSportByRaw.set(raw, await this.sports.normalizeSport(raw));
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name: dto.ownerName,
          phone: dto.ownerPhone,
          passwordHash: await bcrypt.hash(dto.ownerPassword, 10),
          roleId: ownerRole.id,
          status: UserStatus.active,
        },
      });
      const venue = await tx.venue.create({
        data: {
          ownerId: user.id,
          name: dto.venueName,
          address: dto.address,
          city: dto.city,
          phone: dto.venuePhone,
          lat: dto.lat,
          lng: dto.lng,
          sports,
          amenities,
          // approveNow submits the venue for approval (pending) — it goes
          // live through the normal approve action once the photo and
          // readiness requirements are met, like every other venue.
          status: dto.approveNow ? VenueStatus.pending : VenueStatus.draft,
          planId: dto.planId ?? null,
        },
      });
      // Same default staff-role allowances the owner panel grants:
      // platform arena roles only, never another owner's custom roles.
      const allowed = await tx.role.findMany({ where: { scope: 'arena', ownerId: null } });
      if (allowed.length > 0) {
        await tx.venueAllowedRole.createMany({
          data: allowed.map((r) => ({ venueId: venue.id, roleId: r.id })),
          skipDuplicates: true,
        });
      }
      const courts = [];
      for (const c of dto.courts ?? []) {
        courts.push(
          await tx.court.create({
            data: {
              status: 'approved',
              venueId: venue.id,
              name: c.name,
              sport: courtSportByRaw.get(c.sport) ?? c.sport,
              size: c.size,
              surface: c.surface,
              indoor: c.indoor ?? false,
              pricePerHour: c.pricePerHour,
              openMinutes: c.openMinutes ?? 360,
              closeMinutes: c.closeMinutes ?? 1380,
              slotMinutes: c.slotMinutes ?? 60,
            },
          }),
        );
      }
      return { user, venue, courts };
    });

    await this.audit(actorId, 'venue.onboard', 'venue', result.venue.id);
    const fresh = await this.prisma.venue.findUnique({
      where: { id: result.venue.id },
      include: { plan: true, courts: true },
    });
    const { passwordHash: _p, ...safeOwner } = result.user;
    return {
      owner: safeOwner,
      venue: fresh,
      courts: result.courts,
      billing: fresh ? await this.plans.billingSummary(fresh) : null,
    };
  }

  /**
   * Every venue (any status) with owner, courts, plan, billing, readiness
   * and performance stats. `range` (7d | 30d | all) windows the bookings /
   * views / clicks; subscription revenue is the all-time ledger total.
   * `sort`: bookings | views | clicks | revenue | name.
   */
  async listVenuesAdmin(opts?: { sort?: string; range?: string; status?: string; page?: number; limit?: number }) {
    // Server-side status filter: omitted keeps the old load-everything
    // behaviour; an unknown value is a client error, not an empty page.
    const statusFilter = opts?.status;
    if (statusFilter && !Object.values(VenueStatus).includes(statusFilter as VenueStatus)) {
      throw new BadRequestException(`Unknown venue status: ${statusFilter}`);
    }
    const venues = await this.prisma.venue.findMany({
      ...(statusFilter ? { where: { status: statusFilter as VenueStatus } } : {}),
      include: {
        owner: { select: { id: true, name: true, email: true, phone: true, status: true } },
        plan: true,
        courts: { orderBy: { name: 'asc' } },
      },
      orderBy: [{ name: 'asc' }],
    });
    const rangeDays = opts?.range === '7d' ? 7 : opts?.range === '30d' ? 30 : null;
    const since = rangeDays
      ? new Date(Date.now() - (rangeDays - 1) * 86400000)
      : null;
    const sinceDay = since
      ? new Date(
          `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(since)}T00:00:00.000Z`,
        )
      : null;
    const [bookingRows, eventRows, paymentRows, reportRows] = await Promise.all([
      this.prisma.booking.groupBy({
        by: ['venueId'],
        where: {
          status: { in: ['confirmed', 'completed'] },
          ...(since ? { createdAt: { gte: since } } : {}),
        },
        _count: true,
        _sum: { totalPrice: true, discountAmount: true },
      }),
      this.prisma.venueEvent.groupBy({
        by: ['venueId', 'type'],
        where: sinceDay ? { day: { gte: sinceDay } } : {},
        _count: true,
      }),
      this.prisma.venuePayment.groupBy({ by: ['venueId'], _sum: { amount: true } }),
      // Outstanding = open + reviewed: a report under investigation is
      // still an open item, not a closed one.
      this.prisma.venueReport.groupBy({
        by: ['venueId'],
        where: { status: { in: ['open', 'reviewed'] } },
        _count: true,
      }),
    ]);
    const openReportsByVenue = new Map(
      reportRows.map((r) => [r.venueId, r._count]),
    );
    const bookingByVenue = new Map(
      bookingRows.map((r) => [
        r.venueId,
        {
          bookings: r._count,
          gmv: Number(r._sum.totalPrice ?? 0) - Number(r._sum.discountAmount ?? 0),
        },
      ]),
    );
    const eventsByVenue = new Map<string, { views: number; clicks: number }>();
    for (const r of eventRows) {
      const cur = eventsByVenue.get(r.venueId) ?? { views: 0, clicks: 0 };
      if (r.type === 'view') cur.views = r._count;
      if (r.type === 'click') cur.clicks = r._count;
      eventsByVenue.set(r.venueId, cur);
    }
    const revenueByVenue = new Map(
      paymentRows.map((r) => [r.venueId, r._sum.amount ?? 0]),
    );
    const out = [];
    for (const v of venues) {
      const b = bookingByVenue.get(v.id) ?? { bookings: 0, gmv: 0 };
      const e = eventsByVenue.get(v.id) ?? { views: 0, clicks: 0 };
      out.push({
        venue: v,
        billing: await this.plans.billingSummary(v),
        readiness: venueReadiness(v, v.courts.filter((c) => c.isActive && c.status === 'approved').length),
        stats: {
          bookings: b.bookings,
          gmv: b.gmv,
          views: e.views,
          clicks: e.clicks,
          subscriptionRevenue: revenueByVenue.get(v.id) ?? 0,
          openReports: openReportsByVenue.get(v.id) ?? 0,
        },
      });
    }
    const sort = opts?.sort ?? 'bookings';
    out.sort((x, y) => {
      if (sort === 'name') return x.venue.name.localeCompare(y.venue.name);
      if (sort === 'views') return y.stats.views - x.stats.views;
      if (sort === 'clicks') return y.stats.clicks - x.stats.clicks;
      if (sort === 'revenue')
        return y.stats.subscriptionRevenue - x.stats.subscriptionRevenue;
      return y.stats.bookings - x.stats.bookings;
    });
    return offsetPage(out, opts?.page ?? 1, pageLimit(opts?.limit, 50));
  }

  async venueDetailAdmin(venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      include: {
        owner: { select: { id: true, name: true, email: true, phone: true, status: true, createdAt: true } },
        plan: true,
        courts: {
          orderBy: { name: 'asc' },
          include: { _count: { select: { bookings: true } } },
        },
      },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    const dayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
    }).format(new Date());
    const today = new Date(`${dayStr}T00:00:00.000Z`);
    const [
      bookingsTotal,
      bookingsCurrent,
      views,
      clicks,
      courtViews,
      revenueAgg,
      gmvAgg,
      payments,
      courtAgg,
      courtCurrent,
      courtTotals,
      seatsUsed,
    ] = await Promise.all([
      this.prisma.booking.count({
        where: { venueId, status: { not: 'cancelled' } },
      }),
      this.prisma.booking.count({
        where: { venueId, status: 'confirmed', date: { gte: today } },
      }),
      this.prisma.venueEvent.count({ where: { venueId, type: 'view' } }),
      this.prisma.venueEvent.count({ where: { venueId, type: 'click' } }),
      this.prisma.venueEvent.count({ where: { venueId, type: 'court_view' } }),
      this.prisma.venuePayment.aggregate({
        where: { venueId },
        _sum: { amount: true },
      }),
      this.prisma.booking.aggregate({
        where: { venueId, status: { in: ['confirmed', 'completed'] } },
        _sum: { totalPrice: true, discountAmount: true },
      }),
      this.prisma.venuePayment.findMany({
        where: { venueId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          plan: { select: { name: true } },
          recordedBy: { select: { name: true, email: true } },
        },
      }),
      this.prisma.booking.groupBy({
        by: ['courtId'],
        where: { venueId, status: { in: ['confirmed', 'completed'] } },
        _count: true,
        _sum: { totalPrice: true, discountAmount: true },
      }),
      this.prisma.booking.groupBy({
        by: ['courtId'],
        where: { venueId, status: 'confirmed', date: { gte: today } },
        _count: true,
      }),
      // One bookings definition everywhere: everything except cancelled
      // (matches the arena Total bookings). Revenue above stays realized
      // only (confirmed + completed).
      this.prisma.booking.groupBy({
        by: ['courtId'],
        where: { venueId, status: { not: 'cancelled' } },
        _count: true,
      }),
      this.prisma.venueStaff.count({ where: { venueId } }),
    ]);
    const [reports, venueDisputes, openReportsCount, openDisputesCount] =
      await Promise.all([
        this.prisma.venueReport.findMany({
          where: { venueId },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { user: { select: { name: true, email: true } } },
        }),
        this.prisma.dispute.findMany({
          where: { booking: { venueId } },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            raisedBy: { select: { name: true, email: true } },
            booking: {
              select: {
                date: true,
                status: true,
                court: { select: { name: true } },
              },
            },
          },
        }),
        this.prisma.venueReport.count({
          where: { venueId, status: { in: ['open', 'reviewed'] } },
        }),
        this.prisma.dispute.count({
          where: { booking: { venueId }, status: 'open' },
        }),
      ]);
    const courtTotalsMap = new Map(courtTotals.map((r) => [r.courtId, r._count]));
    const courtStats = new Map(
      courtAgg.map((r) => [
        r.courtId,
        {
          bookings: courtTotalsMap.get(r.courtId) ?? 0,
          revenue:
            Number(r._sum.totalPrice ?? 0) - Number(r._sum.discountAmount ?? 0),
        },
      ]),
    );
    // Courts whose bookings are all pending/no-show have no revenue rows.
    for (const [courtId, count] of courtTotalsMap) {
      if (!courtStats.has(courtId)) {
        courtStats.set(courtId, { bookings: count, revenue: 0 });
      }
    }
    const courtCurrentMap = new Map(courtCurrent.map((r) => [r.courtId, r._count]));
    const courts = venue.courts.map((c) => ({
      ...c,
      stats: {
        bookings: courtStats.get(c.id)?.bookings ?? 0,
        revenue: courtStats.get(c.id)?.revenue ?? 0,
        current: courtCurrentMap.get(c.id) ?? 0,
      },
    }));
    const courtLimit = await this.plans.effectiveCourtLimit(venueId);
    const staffLimit = await this.plans.effectiveStaffLimit(venueId);
    const billing = await this.plans.billingSummary(venue);
    const seatPlan =
      venue.plan ??
      (await this.prisma.plan.findFirst({ where: { isDefault: true } }));
    return {
      venue: { ...venue, courts },
      courtLimit,
      staffLimit,
      billing,
      reports,
      disputes: venueDisputes,
      reportCounts: { openReports: openReportsCount, openDisputes: openDisputesCount },
      readiness: venueReadiness(
        venue,
        venue.courts.filter((c) => c.isActive && c.status === 'approved').length,
      ),
      stats: {
        bookingsTotal,
        bookingsCurrent,
        views,
        clicks,
        courtViews,
        subscriptionRevenue: revenueAgg._sum.amount ?? 0,
        gmv:
          Number(gmvAgg._sum.totalPrice ?? 0) -
          Number(gmvAgg._sum.discountAmount ?? 0),
        seatsUsed,
        seatsAllowed: staffLimit.limit,
      },
      payments,
    };
  }

  // ------------------------------------------------------------ charts
  /**
   * Daily series for the venue / court performance charts, bucketed by
   * PLAY date in Asia/Karachi: booking counts per status, revenue from
   * non-cancelled bookings, and discovery traffic from VenueEvent.
   */
  private async dailySeries(
    scope: { venueId: string; courtId?: string },
    days: number,
    range?: { from?: string; to?: string },
  ) {
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    let dayStrs: string[] = [];
    if (
      range?.from &&
      range?.to &&
      DATE_RE.test(range.from) &&
      DATE_RE.test(range.to)
    ) {
      // Custom range, inclusive both ends, capped at 366 days. A reversed
      // range is swapped rather than rejected.
      const start = range.from <= range.to ? range.from : range.to;
      const end = range.from <= range.to ? range.to : range.from;
      const d = new Date(`${start}T00:00:00.000Z`);
      const endD = new Date(`${end}T00:00:00.000Z`);
      while (d <= endD && dayStrs.length < 366) {
        dayStrs.push(d.toISOString().slice(0, 10));
        d.setUTCDate(d.getUTCDate() + 1);
      }
    } else {
      const n = Math.min(90, Math.max(7, Math.floor(days) || 30));
      const todayStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Karachi',
      }).format(new Date());
      for (let i = n - 1; i >= 0; i--) {
        const d = new Date(`${todayStr}T00:00:00.000Z`);
        d.setUTCDate(d.getUTCDate() - i);
        dayStrs.push(d.toISOString().slice(0, 10));
      }
    }
    const from = new Date(`${dayStrs[0]}T00:00:00.000Z`);
    const to = new Date(`${dayStrs[dayStrs.length - 1]}T00:00:00.000Z`);
    const [bookings, events] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          venueId: scope.venueId,
          ...(scope.courtId ? { courtId: scope.courtId } : {}),
          date: { gte: from, lte: to },
        },
        select: { date: true, status: true, totalPrice: true, discountAmount: true },
      }),
      this.prisma.venueEvent.findMany({
        where: {
          venueId: scope.venueId,
          ...(scope.courtId ? { courtId: scope.courtId } : {}),
          day: { gte: from, lte: to },
        },
        select: { day: true, type: true },
      }),
    ]);
    const blank = () => ({
      pending: 0, confirmed: 0, completed: 0, cancelled: 0, noShow: 0,
      revenue: 0, views: 0, clicks: 0, courtViews: 0,
    });
    const byDay = new Map(dayStrs.map((d) => [d, blank()]));
    for (const b of bookings) {
      const row = byDay.get(b.date.toISOString().slice(0, 10));
      if (!row) continue;
      if (b.status === 'pending') row.pending++;
      else if (b.status === 'confirmed') row.confirmed++;
      else if (b.status === 'completed') row.completed++;
      else if (b.status === 'cancelled') row.cancelled++;
      else if (b.status === 'no_show') row.noShow++;
      // Revenue is realized money only (confirmed + completed) — the
      // same definition as every GMV figure in the admin. Pending and
      // no-show bookings count in the state bars, never in revenue.
      if (b.status === 'confirmed' || b.status === 'completed') {
        row.revenue += Number(b.totalPrice) - Number(b.discountAmount);
      }
    }
    for (const e of events) {
      const row = byDay.get(e.day.toISOString().slice(0, 10));
      if (!row) continue;
      if (e.type === 'view') row.views++;
      else if (e.type === 'click') row.clicks++;
      else if (e.type === 'court_view') row.courtViews++;
    }
    return dayStrs.map((date) => ({ date, ...byDay.get(date)! }));
  }

  async venueSeries(
    venueId: string,
    days: number,
    range?: { from?: string; to?: string },
  ) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    return { series: await this.dailySeries({ venueId }, days, range) };
  }

  /** Court detail screen data: court + venue, lifetime totals, chart series, recent bookings. */
  async courtDetailAdmin(
    courtId: string,
    days: number,
    range?: { from?: string; to?: string },
  ) {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: {
        venue: { select: { id: true, name: true, city: true } },
        _count: { select: { bookings: true } },
      },
    });
    if (!court) throw new NotFoundException('Court not found');
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
    }).format(new Date());
    const today = new Date(`${todayStr}T00:00:00.000Z`);
    const [totalBookings, upcoming, revenueAgg, courtViews, recent] =
      await Promise.all([
        this.prisma.booking.count({
          where: { courtId, status: { not: 'cancelled' } },
        }),
        this.prisma.booking.count({
          where: {
            courtId,
            date: { gte: today },
            status: { in: ['pending', 'confirmed'] },
          },
        }),
        this.prisma.booking.aggregate({
          // Realized money only — same rule as the arena GMV.
          where: { courtId, status: { in: ['confirmed', 'completed'] } },
          _sum: { totalPrice: true, discountAmount: true },
        }),
        this.prisma.venueEvent.count({
          where: { courtId, type: 'court_view' },
        }),
        this.prisma.booking.findMany({
          where: { courtId },
          orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
          take: 8,
          include: { user: { select: { name: true } } },
        }),
      ]);
    return {
      court,
      totals: {
        bookings: totalBookings,
        upcoming,
        revenue:
          Number(revenueAgg._sum.totalPrice ?? 0) -
          Number(revenueAgg._sum.discountAmount ?? 0),
        courtViews,
      },
      series: await this.dailySeries({ venueId: court.venueId, courtId }, days, range),
      recentBookings: recent.map((b) => ({
        id: b.id,
        date: b.date,
        startMinutes: b.startMinutes,
        endMinutes: b.endMinutes,
        status: b.status,
        amount: Number(b.totalPrice) - Number(b.discountAmount),
        player: b.user?.name ?? b.guestName ?? 'Walk-in',
        checkedInAt: b.checkedInAt,
      })),
    };
  }

  // ------------------------------------------------------------ moderation
  /**
   * Pause / block / disable a venue (or clear it with status 'none').
   * Any non-'none' state hides the venue from players everywhere. A
   * reason is mandatory and is shown to the owner, who is notified.
   */
  /** Set (or clear, with null) a per-arena court cap that overrides the plan. */
  async setCourtLimit(actorId: string, venueId: string, limit: number | null, confirmBelowUsage = false) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
      throw new BadRequestException('Court limit must be between 1 and 500, or empty for the plan default');
    }
    // A cap below current usage would silently strand live courts: the
    // owner could no longer create, and approval would start failing.
    // Refuse unless the admin explicitly confirms (audited below).
    const usage = await this.prisma.court.count({
      where: { venueId, isActive: true, status: { not: 'rejected' } },
    });
    const effective = limit ?? (await this.plans.effectivePlan({ planId: venue.planId }))?.maxCourts ?? null;
    const belowUsage = effective !== null && usage > effective;
    if (belowUsage && !confirmBelowUsage) {
      throw new BadRequestException(
        `This arena already uses ${usage} courts, above the new limit of ${effective}. Pass confirmBelowUsage to proceed anyway.`,
      );
    }
    await this.prisma.venue.update({
      where: { id: venueId },
      data: { courtLimitOverride: limit },
    });
    await this.audit(
      actorId,
      'venue.court_limit',
      'venue',
      venueId,
      limit === null ? 'limit: plan default' : `limit: ${limit}` + (belowUsage ? ` (confirmed below usage: ${usage})` : ''),
    );
    void this.notifications
      .pushToUser(venue.ownerId, {
        title: 'Court limit updated',
        body:
          limit === null
            ? `Areana reset ${venue.name} to its plan's court limit.`
            : `Areana set ${venue.name}'s court limit to ${limit}.`,
        data: { type: 'venue_limit' },
      })
      .catch(() => {});
    return this.plans.effectiveCourtLimit(venueId);
  }

  /** Set (or clear, with null) a per-arena team-seat cap that overrides the plan. */
  async setStaffLimit(actorId: string, venueId: string, limit: number | null, confirmBelowUsage = false) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > 500)) {
      throw new BadRequestException('Team seat limit must be between 0 and 500, or empty for the plan default');
    }
    const usage = await this.prisma.venueStaff.count({ where: { venueId } });
    const effective = limit ?? (await this.plans.effectivePlan({ planId: venue.planId }))?.maxStaff ?? null;
    const belowUsage = effective !== null && usage > effective;
    if (belowUsage && !confirmBelowUsage) {
      throw new BadRequestException(
        `This arena already has ${usage} team members, above the new limit of ${effective}. Pass confirmBelowUsage to proceed anyway.`,
      );
    }
    await this.prisma.venue.update({
      where: { id: venueId },
      data: { staffLimitOverride: limit },
    });
    await this.audit(
      actorId,
      'venue.staff_limit',
      'venue',
      venueId,
      limit === null ? 'limit: plan default' : `limit: ${limit}` + (belowUsage ? ` (confirmed below usage: ${usage})` : ''),
    );
    void this.notifications
      .pushToUser(venue.ownerId, {
        title: 'Team seat limit updated',
        body:
          limit === null
            ? `Areana reset ${venue.name} to its plan's team seat limit.`
            : `Areana set ${venue.name}'s team seat limit to ${limit}.`,
        data: { type: 'venue_limit' },
      })
      .catch(() => {});
    return this.plans.effectiveStaffLimit(venueId);
  }

  /**
   * Re-run the go-live checklist after a photo/amenity/sport edit: an
   * approved venue that no longer meets it goes back to pending (the
   * owner must fix the gap and resubmit), the same readiness rule as
   * owner edits. Adding a photo or reordering never breaks readiness,
   * so those paths skip this. Returns the final venue row and whether
   * it was dropped.
   */
  private async dropVenueIfUnready(venueId: string) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue || venue.status !== VenueStatus.approved) {
      return { venue, dropped: false };
    }
    const courts = await this.prisma.court.count({
      where: { venueId, isActive: true, status: 'approved' },
    });
    if (venueReadiness(venue, courts).ready) {
      return { venue, dropped: false };
    }
    const dropped = await this.prisma.venue.update({
      where: { id: venueId },
      data: { status: VenueStatus.pending },
    });
    return { venue: dropped, dropped: true };
  }

  /**
   * Super-admin edit of ANY arena's data. Sports are validated against
   * the catalog. Most admin edits leave a live venue live, but a
   * sports/amenities change that breaks the go-live checklist sends an
   * approved venue back to pending — the listing would no longer meet
   * the bar players were shown.
   */
  async updateVenue(
    actorId: string,
    venueId: string,
    dto: {
      name?: string;
      address?: string;
      city?: string;
      phone?: string | null;
      lat?: number | null;
      lng?: number | null;
      sports?: string[];
      amenities?: string[];
      autoAccept?: boolean;
      minAdvanceMinutes?: number;
      maxAdvanceDays?: number;
    },
  ) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    if (dto.minAdvanceMinutes !== undefined || dto.maxAdvanceDays !== undefined) {
      assertBookingWindow(
        dto.minAdvanceMinutes ?? venue.minAdvanceMinutes,
        dto.maxAdvanceDays ?? venue.maxAdvanceDays,
      );
    }
    const data: Prisma.VenueUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;
    if (dto.lat !== undefined || dto.lng !== undefined) {
      assertPakistanCoords(dto.lat ?? venue.lat, dto.lng ?? venue.lng);
    }
    if (dto.amenities !== undefined)
      data.amenities = await this.amenities.normalizeAmenities(dto.amenities, {
        grandfathered: venue.amenities,
      });
    if (dto.autoAccept !== undefined) data.autoAccept = dto.autoAccept;
    if (dto.minAdvanceMinutes !== undefined) data.minAdvanceMinutes = dto.minAdvanceMinutes;
    if (dto.maxAdvanceDays !== undefined) data.maxAdvanceDays = dto.maxAdvanceDays;
    if (dto.sports !== undefined)
      data.sports = await this.sports.normalizeSports(dto.sports, {
        grandfathered: venue.sports,
      });
    const changed = Object.keys(data).filter(
      (k) => JSON.stringify((venue as Record<string, unknown>)[k]) !== JSON.stringify((data as Record<string, unknown>)[k]),
    );
    const updated = await this.prisma.venue.update({ where: { id: venueId }, data });
    await this.audit(
      actorId,
      'venue.edit',
      'venue',
      venueId,
      changed.length ? `changed: ${changed.join(', ')}` : 'no field changes',
    );
    let final = updated;
    let dropped = false;
    if (dto.sports !== undefined || dto.amenities !== undefined) {
      const res = await this.dropVenueIfUnready(venueId);
      final = res.venue ?? updated;
      dropped = res.dropped;
      if (dropped) {
        await this.audit(actorId, 'venue.readiness_drop', 'venue', venueId, 'approved → pending: go-live checklist no longer met after edit');
      }
    }
    if (changed.length > 0) {
      await this.notifications
        .pushToUser(venue.ownerId, {
          title: 'Arena details updated',
          body:
            `Areana admin updated "${venue.name}" (${changed.join(', ')}).` +
            (dropped ? ' It no longer meets the go-live checklist, so it is back in review until the gaps are fixed.' : ''),
          data: { type: 'venue_edited', venueId },
        })
        .catch(() => {});
    }
    // Readiness is counted over approved + active courts (an
    // active-but-pending court does not make the venue go-live ready).
    const activeCourts = await this.prisma.court.count({
      where: { venueId, isActive: true, status: 'approved' },
    });
    return { ...final, readiness: venueReadiness(final, activeCourts), backToPending: dropped };
  }

  async setVenueModeration(
    actorId: string,
    venueId: string,
    dto: { status: string; reason?: string },
  ) {
    const status = dto.status;
    if (!['none', 'paused', 'blocked', 'disabled'].includes(status)) {
      throw new BadRequestException('Invalid moderation status');
    }
    const reason = dto.reason?.trim();
    if (status !== 'none' && !reason) {
      throw new BadRequestException('A reason is required — the owner will see it');
    }
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    const updated = await this.prisma.venue.update({
      where: { id: venueId },
      data: {
        moderationStatus: status,
        moderationReason: status === 'none' ? null : reason,
        moderatedAt: status === 'none' ? null : new Date(),
        moderatedById: status === 'none' ? null : actorId,
      },
    });
    await this.audit(actorId, `venue.moderation.${status}`, 'venue', venueId);
    // Sanctioning a venue cancels its upcoming bookings: players must
    // not keep arriving at an arena the platform just hid from them.
    if (status !== 'none') {
      await this.bookings
        .cancelVenueUpcomingBookings(venueId, `the arena was ${status} by Areana`)
        .catch(() => {});
    }
    const titles: Record<string, string> = {
      paused: 'Your arena has been paused',
      blocked: 'Your arena has been blocked',
      disabled: 'Your arena has been disabled',
      none: 'Your arena is visible again',
    };
    // The clear message mirrors the arenaLive computation used on
    // court approval: approved + unarchived + billing unpaused is what
    // actually makes the arena visible. Telling the owner it is "back"
    // while a billing pause or a non-approved status still hides it
    // would be a lie the panel can't see.
    const arenaLive =
      updated.status === VenueStatus.approved && !updated.archivedAt && !updated.billingPaused;
    await this.notifications
      .pushToUser(venue.ownerId, {
        title: titles[status],
        body:
          status === 'none'
            ? arenaLive
              ? `${venue.name} is back on Areana and visible to players.`
              : `${venue.name} is no longer moderated, but it stays hidden for now — it becomes visible once its approval, archive, and billing state are all clear.`
            : `${venue.name} is hidden from players. Reason: ${reason}`,
        data: { type: 'venue_moderation', venueId },
      })
      .catch(() => {});
    return updated;
  }

  // -------------------------------------------------------- court approvals
  async pendingCourts(cursor?: string) {
    const ks = this.keyset(cursor);
    // Courts of dead venues never leave the queue on their own — and
    // approving one would notify an owner about a court that can never
    // become bookable. Filter them out here, not just at approve time.
    const baseWhere: Prisma.CourtWhereInput = {
      status: 'pending',
      venue: { archivedAt: null, status: { notIn: ['suspended', 'rejected'] } },
    };
    const [total, courts] = await Promise.all([
      this.prisma.court.count({ where: baseWhere }),
      this.prisma.court.findMany({
        where: ks
          ? {
              ...baseWhere,
              OR: [
                { createdAt: { gt: ks.createdAt } },
                { createdAt: ks.createdAt, id: { gt: ks.id } },
              ],
            }
          : baseWhere,
        include: {
          venue: {
            select: {
              id: true,
              name: true,
              city: true,
              status: true,
              moderationStatus: true,
              archivedAt: true,
              owner: { select: { name: true, email: true } },
            },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 31,
      }),
    ]);
    const pageRows = courts.slice(0, 30);
    return {
      items: pageRows,
      total,
      nextCursor: courts.length > 30 ? this.keysetCursor(pageRows[pageRows.length - 1]) : null,
    };
  }

  async approveCourt(actorId: string, courtId: string) {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: {
        venue: {
          select: {
            name: true,
            ownerId: true,
            status: true,
            moderationStatus: true,
            billingPaused: true,
            archivedAt: true,
          },
        },
      },
    });
    if (!court) throw new NotFoundException('Court not found');
    if (court.status !== 'pending') {
      throw new BadRequestException('Only a pending court can be approved');
    }
    if (
      court.venue.archivedAt ||
      court.venue.status === 'suspended' ||
      court.venue.status === 'rejected'
    ) {
      throw new BadRequestException(
        'This arena is archived, suspended, or rejected — its courts cannot be approved',
      );
    }
    // Approving adds a live court, so the venue must still be under its
    // cap (a pending court already counts toward usage while active).
    const { limit: courtLimit } = await this.plans.effectiveCourtLimit(court.venueId);
    if (courtLimit !== null) {
      const usage = await this.prisma.court.count({
        where: { venueId: court.venueId, isActive: true, status: { not: 'rejected' } },
      });
      if (usage > courtLimit) {
        throw new BadRequestException(
          `This arena already uses ${usage} courts, above its limit of ${courtLimit} — raise the limit before approving`,
        );
      }
    }
    const updated = await this.prisma.court.update({
      where: { id: courtId },
      data: { status: 'approved', rejectionReason: null },
    });
    await this.audit(actorId, 'court.approve', 'court', courtId);
    const arenaLive =
      court.venue.status === 'approved' &&
      court.venue.moderationStatus === 'none' &&
      !court.venue.billingPaused;
    await this.notifications
      .pushToUser(court.venue.ownerId, {
        title: 'Court approved',
        body: arenaLive
          ? `${court.name} at ${court.venue.name} is live — players can now book it.`
          : `${court.name} at ${court.venue.name} is approved — it becomes bookable once the arena itself is live.`,
        data: { type: 'court_approved', venueId: court.venueId },
      })
      .catch(() => {});
    return updated;
  }

  async rejectCourt(actorId: string, courtId: string, note?: string) {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: { venue: { select: { name: true, ownerId: true } } },
    });
    if (!court) throw new NotFoundException('Court not found');
    // Rejecting a court with upcoming bookings strands players who
    // already paid (or planned) around it — refuse and name the count.
    const upcoming = await this.prisma.booking.count({
      where: {
        courtId,
        date: { gte: startOfToday() },
        status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
      },
    });
    if (upcoming > 0) {
      throw new BadRequestException(
        `This court has ${upcoming} upcoming booking${upcoming === 1 ? '' : 's'} — cancel or move them before rejecting it`,
      );
    }
    const reason = note?.trim() || null;
    const updated = await this.prisma.court.update({
      where: { id: courtId },
      data: { status: 'rejected', rejectionReason: reason },
    });
    await this.audit(actorId, 'court.reject', 'court', courtId, reason ?? undefined);
    await this.notifications
      .pushToUser(court.venue.ownerId, {
        title: 'Court not approved',
        body: `${court.name} at ${court.venue.name} was not approved.${note ? ` Note: ${note}` : ''} Edit it and it goes back into the review queue.`,
        data: { type: 'court_rejected', venueId: court.venueId },
      })
      .catch(() => {});
    return updated;
  }

  // ---------------------------------------------------------- courts (admin-managed)
  /** Court names stay unique per arena (players/staff tell courts apart by name). */
  private async assertCourtNameFree(
    venueId: string,
    name: string,
    excludeId?: string,
  ) {
    const siblings = await this.prisma.court.findMany({
      where: { venueId, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { name: true },
    });
    const wanted = name.trim().toLowerCase();
    if (siblings.some((c) => c.name.trim().toLowerCase() === wanted)) {
      throw new BadRequestException(
        `A court named "${name.trim()}" already exists at this arena`,
      );
    }
  }

  private async syncVenueSports(venueId: string) {
    const [courts, venue] = await Promise.all([
      this.prisma.court.findMany({
        where: { venueId, isActive: true },
        select: { sport: true },
      }),
      this.prisma.venue.findUnique({ where: { id: venueId }, select: { sports: true } }),
    ]);
    // Union, never shrink (same rule as the owner flow).
    const sports = [...new Set([...(venue?.sports ?? []), ...courts.map((c) => c.sport)])];
    await this.prisma.venue.update({ where: { id: venueId }, data: { sports } });
  }

  private courtPhotoEntries(court: { photos?: unknown }): { url: string; blurhash?: string; width?: number; height?: number }[] {
    if (!Array.isArray(court.photos)) return [];
    return court.photos.filter(
      (e): e is { url: string } =>
        !!e && typeof e === 'object' && typeof (e as { url?: unknown }).url === 'string',
    );
  }

  /** Admin adds a court directly — admin-created courts are approved instantly. */
  async createCourt(
    actorId: string,
    venueId: string,
    dto: {
      name: string;
      sport: string;
      size?: string;
      surface?: string;
      indoor?: boolean;
      pricePerHour: number;
      openMinutes?: number;
      closeMinutes?: number;
      slotMinutes?: number;
    },
  ) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    if (venue.archivedAt || venue.status === 'suspended' || venue.status === 'rejected') {
      throw new BadRequestException(
        'Courts cannot be added while the arena is archived, suspended, or rejected',
      );
    }
    await this.assertCourtNameFree(venueId, dto.name);
    const open0 = dto.openMinutes ?? 360;
    const close0 = dto.closeMinutes ?? 1380;
    if (close0 - open0 < 60 || close0 - open0 > 1200) {
      throw new BadRequestException('Court hours must span between 1 and 20 hours');
    }
    // Admin-created courts are approved instantly, so they count
    // against the venue's cap the same way owner-created ones do.
    const { limit: courtLimit } = await this.plans.effectiveCourtLimit(venueId);
    if (courtLimit !== null) {
      const usage = await this.prisma.court.count({
        where: { venueId, isActive: true, status: { not: 'rejected' } },
      });
      if (usage >= courtLimit) {
        throw new BadRequestException(
          `This arena already uses ${usage} courts, at its limit of ${courtLimit}`,
        );
      }
    }
    const sport = await this.sports.normalizeSport(dto.sport);
    const court = await this.prisma.court.create({
      data: {
        venueId,
        name: dto.name,
        sport,
        size: dto.size,
        surface: dto.surface,
        indoor: dto.indoor ?? false,
        pricePerHour: dto.pricePerHour,
        openMinutes: dto.openMinutes ?? 360,
        closeMinutes: dto.closeMinutes ?? 1380,
        slotMinutes: dto.slotMinutes ?? 60,
        status: 'approved',
      },
    });
    await this.syncVenueSports(venueId);
    await this.audit(actorId, 'court.create', 'court', court.id, `${court.name} at venue ${venueId}`);
    await this.notifications
      .pushToUser(venue.ownerId, {
        title: 'New court added',
        body: `Areana admin added "${court.name}" (${court.sport}) to "${venue.name}".`,
        data: { type: 'court_created', venueId },
      })
      .catch(() => {});
    return court;
  }

  async updateCourt(
    actorId: string,
    courtId: string,
    dto: {
      name?: string;
      sport?: string;
      size?: string;
      surface?: string;
      indoor?: boolean;
      pricePerHour?: number;
      openMinutes?: number;
      closeMinutes?: number;
      slotMinutes?: number;
      isActive?: boolean;
    },
  ) {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: { venue: { select: { name: true, ownerId: true } } },
    });
    if (!court) throw new NotFoundException('Court not found');
    if (dto.name !== undefined && dto.name !== court.name) {
      await this.assertCourtNameFree(court.venueId, dto.name, courtId);
    }
    const data: Prisma.CourtUpdateInput = { ...dto };
    if (dto.sport !== undefined)
      data.sport = await this.sports.normalizeSport(dto.sport, court.sport);
    const newOpen = dto.openMinutes ?? court.openMinutes;
    const newClose = dto.closeMinutes ?? court.closeMinutes;
    if (newClose - newOpen < 60 || newClose - newOpen > 1200) {
      throw new BadRequestException('Court hours must span between 1 and 20 hours');
    }
    if (dto.openMinutes !== undefined || dto.closeMinutes !== undefined) {
      // Shrinking hours must not strand confirmed upcoming bookings.
      const stranded = await this.prisma.booking.count({
        where: {
          courtId,
          status: BookingStatus.confirmed,
          date: { gte: startOfToday() },
          OR: [{ startMinutes: { lt: newOpen } }, { endMinutes: { gt: newClose } }],
        },
      });
      if (stranded > 0) {
        throw new ConflictException(
          `${stranded} upcoming booking(s) fall outside the new hours — move or cancel them first`,
        );
      }
    }
    // An approved court whose price, sport, hours, or slot length
    // actually changes goes back into the review queue — players were
    // shown the old terms, and the change needs a second look. A
    // rejected court edited by an admin likewise re-queues (it can no
    // longer be re-approved from the rejected state otherwise).
    // isActive toggles, name, size, surface, and indoor do not re-queue.
    const requeueFields = ['pricePerHour', 'sport', 'openMinutes', 'closeMinutes', 'slotMinutes'] as const;
    const requeue =
      court.status === 'rejected' ||
      (court.status === 'approved' &&
        requeueFields.some((f) => dto[f] !== undefined && (data as Record<string, unknown>)[f] !== court[f]));
    if (requeue) {
      data.status = 'pending';
      data.rejectionReason = null;
    }
    const updated = await this.prisma.court.update({ where: { id: courtId }, data });
    await this.syncVenueSports(court.venueId);
    await this.audit(
      actorId,
      'court.update',
      'court',
      courtId,
      `${court.name}: ${Object.keys(dto).join(', ')}` + (requeue ? ' (back to pending review)' : ''),
    );
    await this.notifications
      .pushToUser(court.venue.ownerId, {
        title: 'Court updated',
        body:
          `Areana admin updated "${court.name}" at "${court.venue.name}".` +
          (requeue ? ' It is back in the review queue.' : ''),
        data: { type: 'court_updated', venueId: court.venueId },
      })
      .catch(() => {});
    return updated;
  }

  /**
   * Court delete rule: refuse only for (a) any pending/confirmed
   * booking (any date — non-terminal bookings can still be acted on),
   * (b) any dispute on a cancelled booking, or (c) any OPEN dispute
   * on any booking of the court. Otherwise the court goes with its
   * history: completed/no-show/cancelled-undisputed booking rows are
   * deleted in the same transaction (their participants, reschedules,
   * reviews, and game posts cascade; resolved/dismissed disputes are
   * deleted explicitly because Dispute.bookingId has no onDelete, and
   * promo redemptions are nulled via PromoRedemption's SetNull).
   * Consequence to be aware of: deleting a court with history also
   * deletes those bookings' reviews — deactivate instead if the
   * history must survive.
   */
  async deleteCourt(actorId: string, courtId: string) {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: { venue: { select: { name: true, ownerId: true } } },
    });
    if (!court) throw new NotFoundException('Court not found');
    const live = await this.prisma.booking.count({
      where: { courtId, status: { in: [BookingStatus.pending, BookingStatus.confirmed] } },
    });
    if (live > 0) {
      throw new ConflictException(
        `This court has ${live} live booking(s) — cancel or complete them first, or deactivate it instead of deleting it`,
      );
    }
    const disputed = await this.prisma.dispute.count({
      where: { booking: { courtId, status: BookingStatus.cancelled } },
    });
    if (disputed > 0) {
      throw new ConflictException(
        'This court has cancelled bookings with disputes on record — it cannot be deleted',
      );
    }
    const openDisputed = await this.prisma.dispute.count({
      where: { booking: { courtId }, status: 'open' },
    });
    if (openDisputed > 0) {
      throw new ConflictException(
        'This court has bookings with open disputes — resolve them before deleting it',
      );
    }
    // Waiters are told BEFORE their rows are deleted — unlike the
    // player-suspend path, which pings waiters on freed slots, a court
    // delete used to silently drop waitlist entries.
    const waiters = await this.prisma.slotWaitlist.findMany({
      where: { courtId },
      select: { userId: true },
    });
    for (const w of waiters) {
      await this.notifications
        .pushToUser(w.userId, {
          title: 'Court removed',
          body: `A court you were waiting on at "${court.venue.name}" was removed by Areana admin, so your waitlist entry is closed.`,
          data: { type: 'court_deleted', venueId: court.venueId },
        })
        .catch(() => {});
    }
    await this.prisma.$transaction(async (tx) => {
      // Only historical bookings can remain at this point; resolved or
      // dismissed disputes on them are removed explicitly (no onDelete),
      // then the bookings themselves (cascades take participants,
      // reschedules, reviews, and game posts).
      await tx.dispute.deleteMany({ where: { booking: { courtId } } });
      await tx.booking.deleteMany({ where: { courtId } });
      await tx.slotWaitlist.deleteMany({ where: { courtId } });
      await tx.court.delete({ where: { id: courtId } });
    });
    // The court's photo files go with it (single-photo deletes already
    // clean up; a whole-court delete must not leak the files). This
    // runs after the commit and is best-effort: a storage failure
    // orphans a file, it must never fail a delete that already
    // committed (there is no retry job queue to hand this to).
    for (const entry of this.courtPhotoEntries(court)) {
      await this.storage.deleteImage(entry.url).catch(() => {});
    }
    await this.syncVenueSports(court.venueId);
    await this.audit(actorId, 'court.delete', 'court', courtId, court.name);
    await this.notifications
      .pushToUser(court.venue.ownerId, {
        title: 'Court removed',
        body: `Areana admin removed "${court.name}" from "${court.venue.name}".`,
        data: { type: 'court_deleted', venueId: court.venueId },
      })
      .catch(() => {});
    return { deleted: true };
  }

  async addCourtImage(courtId: string, file: Express.Multer.File) {
    const court = await this.prisma.court.findUnique({ where: { id: courtId } });
    if (!court) throw new NotFoundException('Court not found');
    const photo = await this.storage.saveCourtImage(courtId, file);
    const entries = [...this.courtPhotoEntries(court), photo];
    return this.prisma.court.update({ where: { id: courtId }, data: { photos: entries } });
  }

  async removeCourtImage(courtId: string, url: string) {
    const court = await this.prisma.court.findUnique({ where: { id: courtId } });
    if (!court) throw new NotFoundException('Court not found');
    await this.storage.deleteImage(url);
    const entries = this.courtPhotoEntries(court).filter((e) => e.url !== url);
    return this.prisma.court.update({ where: { id: courtId }, data: { photos: entries } });
  }

  // ---------------------------------------------------------- venue images
  async addVenueImage(venueId: string, file: Express.Multer.File, sport?: string) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    const photo = await this.storage.saveVenueImage(venueId, file);
    const entries = [
      ...photoEntriesOf(venue),
      { ...photo, sport: sport && sport.trim() ? sport.trim() : undefined },
    ];
    return this.prisma.venue.update({
      where: { id: venueId },
      data: { images: entries.map((e) => e.url), photos: entries },
    });
  }

  async tagVenueImage(venueId: string, url: string, sport: string | null) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    const entries = withSportTag(photoEntriesOf(venue), url, sport);
    await this.prisma.venue.update({
      where: { id: venueId },
      data: { photos: entries },
    });
    // Untagging can break the per-sport photo rule for an approved venue.
    const { venue: final } = await this.dropVenueIfUnready(venueId);
    return final ?? venue;
  }

  /** Reorder a venue's photos (first photo is the cover everywhere). Same-set guard as the owner endpoint. */
  async reorderVenueImages(venueId: string, urls: string[]) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    const entries = photoEntriesOf(venue);
    const current = entries.map((e) => e.url);
    const sameSet =
      urls.length === current.length &&
      [...urls].sort().join('|') === [...current].sort().join('|');
    if (!sameSet) {
      throw new BadRequestException('Photo order must contain exactly the current photos');
    }
    const byUrl = new Map(entries.map((e) => [e.url, e]));
    const ordered = urls.map((u) => byUrl.get(u) as { url: string });
    return this.prisma.venue.update({
      where: { id: venueId },
      data: { images: urls, photos: ordered },
    });
  }

  /** Soft duplicate check for onboarding: same phone, or same name+city. */
  async onboardDuplicateCheck(q: { phone?: string; name?: string; city?: string }) {
    const digits = (q.phone ?? '').replace(/\D/g, '');
    const suffix = digits.length >= 9 ? digits.slice(-9) : null;
    const or: Prisma.VenueWhereInput[] = [];
    if (suffix) or.push({ phone: { contains: suffix } });
    if (q.name && q.city) {
      or.push({
        name: { equals: q.name, mode: 'insensitive' },
        city: { equals: q.city, mode: 'insensitive' },
      });
    }
    if (or.length === 0) return { duplicates: [] };
    const duplicates = await this.prisma.venue.findMany({
      where: { archivedAt: null, OR: or },
      select: { id: true, name: true, city: true, phone: true, status: true },
      take: 5,
    });
    return { duplicates };
  }

  async removeVenueImage(venueId: string, url: string) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    await this.storage.deleteImage(url);
    const entries = photoEntriesOf(venue).filter((e) => e.url !== url);
    await this.prisma.venue.update({
      where: { id: venueId },
      data: { images: entries.map((e) => e.url), photos: entries },
    });
    // Removing a photo can drop an approved venue below 4 photos or
    // remove the only tagged photo for a sport.
    const { venue: final } = await this.dropVenueIfUnready(venueId);
    return final ?? venue;
  }

  // ------------------------------------------------------------------ plans
  listPlans() {
    return this.plans.listPlans();
  }

  async createPlan(actorId: string, dto: CreatePlanDto) {
    const plan = await this.plans.createPlan(dto);
    await this.audit(actorId, 'plan.create', 'plan', plan.id);
    return plan;
  }

  async updatePlan(actorId: string, id: string, dto: UpdatePlanDto) {
    // Lowering a plan's caps must not silently strand venues already
    // above them: refuse unless the admin explicitly confirms. Only
    // venues whose effective limit comes from the plan are checked —
    // an override on the venue already supersedes the plan.
    const confirmBelowUsage = dto.confirmBelowUsage ?? false;
    const newCourts = dto.maxCourts;
    const newStaff = dto.maxStaff;
    let over: string[] = [];
    if (newCourts !== undefined || newStaff !== undefined) {
      const venues = await this.prisma.venue.findMany({
        where: { planId: id },
        select: { id: true, name: true, courtLimitOverride: true, staffLimitOverride: true },
      });
      for (const v of venues) {
        // Each limit is checked only when the venue has no override
        // for it — an override already supersedes the plan there.
        const [courtUsage, staffUsage] = await Promise.all([
          v.courtLimitOverride === null
            ? this.prisma.court.count({ where: { venueId: v.id, isActive: true, status: { not: 'rejected' } } })
            : Promise.resolve(0),
          v.staffLimitOverride === null
            ? this.prisma.venueStaff.count({ where: { venueId: v.id } })
            : Promise.resolve(0),
        ]);
        if (v.courtLimitOverride === null && newCourts !== undefined && newCourts !== null && courtUsage > newCourts) {
          over.push(`${v.name}: courts ${courtUsage} > ${newCourts}`);
        }
        if (v.staffLimitOverride === null && newStaff !== undefined && newStaff !== null && staffUsage > newStaff) {
          over.push(`${v.name}: team seats ${staffUsage} > ${newStaff}`);
        }
      }
      if (over.length > 0 && !confirmBelowUsage) {
        throw new BadRequestException(
          `Venues already above the new limits: ${over.join('; ')}. Pass confirmBelowUsage to proceed anyway.`,
        );
      }
    }
    const plan = await this.plans.updatePlan(id, dto);
    await this.audit(
      actorId,
      'plan.update',
      'plan',
      id,
      over.length > 0 ? `confirmed below usage: ${over.join('; ')}` : undefined,
    );
    return plan;
  }

  async deletePlan(actorId: string, id: string) {
    const result = await this.plans.deletePlan(id);
    await this.audit(actorId, 'plan.delete', 'plan', id);
    return result;
  }

  /** All approved venues with their plan + billing state (Plans page). */
  async listVenueBilling(page = 1, rawLimit?: number, status?: string) {
    // Server-side status filter: omitted keeps the approved-only
    // default; an unknown value is a client error, not an empty page.
    if (status && !Object.values(VenueStatus).includes(status as VenueStatus)) {
      throw new BadRequestException(`Unknown venue status: ${status}`);
    }
    const venues = await this.prisma.venue.findMany({
      where: { status: status ? (status as VenueStatus) : VenueStatus.approved },
      include: {
        plan: true,
        owner: { select: { id: true, name: true, email: true } },
      },
      orderBy: { name: 'asc' },
    });
    const out = [];
    for (const v of venues) {
      out.push({ venue: v, billing: await this.plans.billingSummary(v) });
    }
    return offsetPage(out, page, pageLimit(rawLimit, 50));
  }

  async venueBilling(venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      include: {
        plan: true,
        owner: { select: { id: true, name: true, email: true } },
      },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    const billing = await this.plans.billingSummary(venue);
    return { venue, billing };
  }

  async assignVenuePlan(actorId: string, venueId: string, planId: string, restartBilling = false, confirmBelowUsage = false) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan not found');
    // Switching to a smaller plan must not silently strand live courts
    // or team seats: refuse unless the admin explicitly confirms.
    const [courtUsage, staffUsage] = await Promise.all([
      this.prisma.court.count({ where: { venueId, isActive: true, status: { not: 'rejected' } } }),
      this.prisma.venueStaff.count({ where: { venueId } }),
    ]);
    const over: string[] = [];
    if (plan.maxCourts !== null && courtUsage > plan.maxCourts) over.push(`courts ${courtUsage} > ${plan.maxCourts}`);
    if (plan.maxStaff !== null && staffUsage > plan.maxStaff) over.push(`team seats ${staffUsage} > ${plan.maxStaff}`);
    if (over.length > 0 && !confirmBelowUsage) {
      throw new BadRequestException(
        `This arena already uses ${over.join(', ')} — above the ${plan.name} plan's limits. Pass confirmBelowUsage to proceed anyway.`,
      );
    }
    const venue = await this.plans.assignPlan(venueId, planId, restartBilling);
    await this.audit(
      actorId,
      'venue.plan.assign',
      'venue',
      venueId,
      over.length > 0 ? `plan: ${plan.name} (confirmed below usage: ${over.join(', ')})` : `plan: ${plan.name}`,
    );
    await this.notifications
      .pushToUser(venue.ownerId, {
        title: 'Your arena plan changed',
        body: `${venue.name} is now on the ${plan.name} plan${restartBilling ? ' and its billing clock restarted from today' : ''}.`,
        data: { type: 'plan_assigned', venueId },
      })
      .catch(() => {});
    return { venue, billing: await this.plans.billingSummary(venue) };
  }

  async extendVenueFree(actorId: string, venueId: string, months: number) {
    const venue = await this.plans.extendFree(venueId, months);
    await this.audit(actorId, 'venue.billing.extend_free', 'venue', venueId);
    await this.notifications
      .pushToUser(venue.ownerId, {
        title: 'Free period extended',
        body: `${venue.name}'s free period was extended by ${months} month${months === 1 ? '' : 's'}.`,
        data: { type: 'billing_free_extended', venueId },
      })
      .catch(() => {});
    return { venue, billing: await this.plans.billingSummary(venue) };
  }

  async markVenuePaid(
    actorId: string,
    venueId: string,
    opts?: { method?: string; note?: string; amount?: number },
  ) {
    const before = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { billingPaused: true },
    });
    const venue = await this.plans.markPaid(venueId, actorId, opts);
    await this.audit(actorId, 'venue.billing.mark_paid', 'venue', venueId);
    await this.notifications
      .pushToUser(venue.ownerId, {
        title: 'Payment received',
        body: before?.billingPaused
          ? `${venue.name}'s payment was recorded and the arena is live again.`
          : `${venue.name}'s payment was recorded.`,
        data: { type: 'billing_paid', venueId },
      })
      .catch(() => {});
    return { venue, billing: await this.plans.billingSummary(venue) };
  }

  async rejectVenue(actorId: string, venueId: string, reason?: string) {
    const existing = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!existing) throw new NotFoundException('Venue not found');
    if (existing.status !== VenueStatus.pending && existing.status !== VenueStatus.draft) {
      throw new BadRequestException(
        `This venue is ${existing.status} — only a pending submission can be rejected. Refresh the queue.`,
      );
    }
    const venue = await this.prisma.venue.update({
      where: { id: venueId },
      data: { status: VenueStatus.rejected, rejectionReason: reason?.trim() || null },
    });
    await this.audit(actorId, 'venue.reject', 'venue', venueId, reason);
    await this.notifications
      .pushToUser(venue.ownerId, {
        title: 'Your arena was not approved',
        body: reason?.trim()
          ? `${venue.name} won't go live. Reason: ${reason.trim()} Fix it, then submit it again.`
          : `${venue.name} won't go live. Check its photos, location and details, then submit it again.`,
        data: { type: 'venue_rejected', venueId },
      })
      .catch(() => {});
    return venue;
  }

  async suspendVenue(actorId: string, venueId: string) {
    const existing = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!existing) throw new NotFoundException('Venue not found');
    if (existing.status !== VenueStatus.pending && existing.status !== VenueStatus.approved) {
      throw new BadRequestException(
        `This venue is ${existing.status} — only a pending or live venue can be suspended.`,
      );
    }
    const venue = await this.prisma.venue.update({
      where: { id: venueId },
      data: { status: VenueStatus.suspended },
    });
    await this.audit(actorId, 'venue.suspend', 'venue', venueId);
    // A suspended venue's upcoming bookings do not stand.
    await this.bookings
      .cancelVenueUpcomingBookings(venueId, 'the arena was suspended by Areana')
      .catch(() => {});
    await this.notifications
      .pushToUser(venue.ownerId, {
        title: 'Your arena has been suspended',
        body: `${venue.name} is hidden from players and takes no new bookings until it is reinstated.`,
        data: { type: 'venue_suspended', venueId },
      })
      .catch(() => {});
    return venue;
  }

  /**
   * The missing half of suspendVenue: restore a suspended arena. It
   * goes straight back to approved only if it passes the same guards
   * as a fresh approval (sanction-free, unarchived, billing unpaused,
   * active owner, readiness met); otherwise it lands in pending for a
   * normal approval decision instead of silently going live half-ready.
   */
  async unsuspendVenue(actorId: string, venueId: string) {
    const existing = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!existing) throw new NotFoundException('Venue not found');
    if (existing.status !== VenueStatus.suspended) {
      throw new BadRequestException(
        `This venue is ${existing.status} — only a suspended venue can be reinstated.`,
      );
    }
    const owner = await this.prisma.user.findUnique({
      where: { id: existing.ownerId },
      select: { status: true },
    });
    const courts = await this.prisma.court.count({
      where: { venueId, isActive: true, status: 'approved' },
    });
    const readiness = venueReadiness(existing, courts);
    const canGoLive =
      existing.moderationStatus === 'none' &&
      !existing.archivedAt &&
      !existing.billingPaused &&
      owner?.status === UserStatus.active &&
      readiness.ready;
    const venue = await this.prisma.venue.update({
      where: { id: venueId },
      data: { status: canGoLive ? VenueStatus.approved : VenueStatus.pending },
    });
    await this.audit(actorId, 'venue.unsuspend', 'venue', venueId);
    await this.notifications
      .pushToUser(venue.ownerId, {
        title: canGoLive ? 'Your arena is live again' : 'Your arena is back in review',
        body: canGoLive
          ? `${venue.name} is visible to players again.`
          : `${venue.name} was reinstated into the approval queue — it goes live once it passes review.`,
        data: { type: 'venue_unsuspended', venueId },
      })
      .catch(() => {});
    return venue;
  }

  /**
   * Rejected venues and courts go back to pending — the queue, not
   * straight to live — so a rejection is recoverable without a fresh
   * submission, but still passes a real approval decision.
   */
  async requeueVenue(actorId: string, venueId: string) {
    const existing = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!existing) throw new NotFoundException('Venue not found');
    if (existing.status !== VenueStatus.rejected) {
      throw new BadRequestException(
        `This venue is ${existing.status} — only a rejected venue can be sent back for review.`,
      );
    }
    const venue = await this.prisma.venue.update({
      where: { id: venueId },
      data: { status: VenueStatus.pending, rejectionReason: null },
    });
    await this.audit(actorId, 'venue.requeue', 'venue', venueId);
    await this.notifications
      .pushToUser(venue.ownerId, {
        title: 'Your arena is back in review',
        body: `${venue.name} was sent back for approval review.`,
        data: { type: 'venue_requeued', venueId },
      })
      .catch(() => {});
    return venue;
  }

  async requeueCourt(actorId: string, courtId: string) {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: { venue: { select: { name: true, ownerId: true } } },
    });
    if (!court) throw new NotFoundException('Court not found');
    if (court.status !== 'rejected') {
      throw new BadRequestException(
        `This court is ${court.status} — only a rejected court can be sent back for review.`,
      );
    }
    const updated = await this.prisma.court.update({
      where: { id: courtId },
      data: { status: 'pending' },
    });
    await this.audit(actorId, 'court.requeue', 'court', courtId);
    await this.notifications
      .pushToUser(court.venue.ownerId, {
        title: 'Court back in review',
        body: `${court.name} at ${court.venue.name} was sent back for approval review.`,
        data: { type: 'court_requeued', venueId: court.venueId },
      })
      .catch(() => {});
    return updated;
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
    // Platform roles or this arena owner's own roles — never another
    // owner's role, which would let its owner rewrite this venue's
    // staff permissions from their own panel.
    if (roles.some((r) => r.ownerId !== null && r.ownerId !== venue.ownerId)) {
      throw new BadRequestException('Only platform roles or this arena owner\'s roles can be enabled');
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
  async listPromos(cursor?: string, rawLimit?: number) {
    const limit = pageLimit(rawLimit, 50);
    const ks = this.keyset(cursor);
    const rows = await this.prisma.promoCode.findMany({
      where: ks
        ? {
            OR: [
              { createdAt: { lt: ks.createdAt } },
              { createdAt: ks.createdAt, id: { lt: ks.id } },
            ],
          }
        : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        venue: { select: { id: true, name: true } },
      },
    });
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor:
        rows.length > limit && items.length
          ? this.keysetCursor(items[items.length - 1])
          : null,
    };
  }

  async createPromo(actorId: string, dto: any) {
    if (dto.kind === 'percent' && (dto.value < 1 || dto.value > 100)) {
      throw new BadRequestException('Percent promo value must be between 1 and 100');
    }
    if (dto.kind === 'flat' && dto.value < 1) {
      throw new BadRequestException('Flat promo value must be at least Rs 1');
    }
    const validTo = new Date(dto.validTo);
    if (isNaN(validTo.getTime())) {
      throw new BadRequestException('validTo must be a valid date');
    }
    const validFrom = dto.validFrom ? new Date(dto.validFrom) : undefined;
    if (validFrom && isNaN(validFrom.getTime())) {
      throw new BadRequestException('validFrom must be a valid date');
    }
    if (validFrom && validFrom >= validTo) {
      throw new BadRequestException('validFrom must be before validTo');
    }
    if (validTo <= new Date()) {
      throw new BadRequestException('validTo must be in the future — a promo that already expired can never be redeemed');
    }
    const code = (dto.code ?? `PROMO-${Math.random().toString(36).slice(2, 8).toUpperCase()}`).toUpperCase();
    // Pre-check the code so a clash is a clean 409, not a raw Prisma
    // error — and still map P2002, because two admins can race the
    // pre-check.
    const clash = await this.prisma.promoCode.findUnique({ where: { code } });
    if (clash) throw new ConflictException('This promo code is already in use');
    let promo;
    try {
      promo = await this.prisma.promoCode.create({
        data: {
          code,
          kind: dto.kind,
          value: dto.value,
          maxDiscount: dto.maxDiscount,
          maxUses: dto.maxUses,
          perUserLimit: dto.perUserLimit ?? 1,
          validFrom,
          validTo,
          isActive: dto.isActive ?? true,
        },
      });
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException('This promo code is already in use');
      }
      throw e;
    }
    await this.audit(actorId, 'promo.create', 'promo', promo.id);
    return promo;
  }

  /**
   * Admin promo edit (panel edit modal). Mirrors the owner update guard
   * exactly: once a promo has any redemption, its terms are frozen and
   * only activation may change; maxUses may never drop below usedCount.
   * Code and kind are immutable — they identify the offer.
   */
  async updatePromo(actorId: string, id: string, dto: UpdatePromoDto) {
    const promo = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!promo) throw new NotFoundException('Promo not found');
    const data: Prisma.PromoCodeUpdateInput = {};
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    const termsChanged =
      dto.value !== undefined ||
      dto.maxDiscount !== undefined ||
      dto.maxUses !== undefined ||
      dto.perUserLimit !== undefined ||
      dto.validFrom !== undefined ||
      dto.validTo !== undefined;
    if (termsChanged && promo.usedCount > 0) {
      throw new BadRequestException(
        'This promo has already been redeemed — only activation can be changed now',
      );
    }
    if (dto.value !== undefined) {
      if (promo.kind === 'percent' && (dto.value < 1 || dto.value > 100)) {
        throw new BadRequestException('Percent promo value must be between 1 and 100');
      }
      if (promo.kind === 'flat' && dto.value < 1) {
        throw new BadRequestException('Flat promo value must be at least Rs 1');
      }
      data.value = dto.value;
    }
    if (dto.maxDiscount !== undefined) data.maxDiscount = dto.maxDiscount;
    if (dto.maxUses !== undefined) {
      if (dto.maxUses < promo.usedCount) {
        throw new BadRequestException(
          `maxUses (${dto.maxUses}) is below the ${promo.usedCount} redemption(s) already made`,
        );
      }
      data.maxUses = dto.maxUses;
    }
    if (dto.perUserLimit !== undefined) data.perUserLimit = dto.perUserLimit;
    const validFrom = dto.validFrom !== undefined ? new Date(dto.validFrom) : undefined;
    const validTo = dto.validTo !== undefined ? new Date(dto.validTo) : undefined;
    if (validFrom && isNaN(validFrom.getTime())) {
      throw new BadRequestException('validFrom must be a valid date');
    }
    if (validTo && isNaN(validTo.getTime())) {
      throw new BadRequestException('validTo must be a valid date');
    }
    const effFrom = validFrom ?? promo.validFrom;
    const effTo = validTo ?? promo.validTo;
    if (validFrom) data.validFrom = validFrom;
    if (validTo) {
      if (validTo <= new Date()) {
        throw new BadRequestException('validTo must be in the future');
      }
      data.validTo = validTo;
    }
    if (effFrom && effFrom >= effTo) {
      throw new BadRequestException('validFrom must be before validTo');
    }
    const updated = await this.prisma.promoCode.update({ where: { id }, data });
    await this.audit(actorId, 'promo.update', 'promo', id);
    return updated;
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
    return this.badges.grantBadge(venueId, badgeId, actorId).then(async (granted) => {
      await this.audit(actorId, 'venue.grant_badge', 'venue', venueId);
      const venue = await this.prisma.venue.findUnique({
        where: { id: venueId },
        select: { ownerId: true, name: true },
      });
      if (venue) {
        await this.notifications
          .pushToUser(venue.ownerId, {
            title: 'Your arena earned a badge',
            body: `${venue.name} earned the ${granted.badge.name} badge.`,
            data: { type: 'badge_granted', venueId },
          })
          .catch(() => {});
      }
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
  async listDisputes(status?: string, cursor?: string, rawLimit?: number, q?: string) {
    const limit = pageLimit(rawLimit, 50);
    const ks = this.keyset(cursor);
    // Server-side search across booking id, reason, raiser name/email,
    // and venue name. The keyset clause is a second OR, so every clause
    // goes through an AND array — spreading baseWhere next to a keyset
    // OR would silently drop one of them.
    const filterClauses: Prisma.DisputeWhereInput[] = [];
    if (status) filterClauses.push({ status });
    if (q?.trim()) {
      const term = q.trim();
      filterClauses.push({
        OR: [
          { bookingId: { contains: term } },
          { reason: { contains: term, mode: 'insensitive' } },
          {
            raisedBy: {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { email: { contains: term, mode: 'insensitive' } },
              ],
            },
          },
          { booking: { venue: { name: { contains: term, mode: 'insensitive' } } } },
        ],
      });
    }
    const filterWhere: Prisma.DisputeWhereInput =
      filterClauses.length > 0 ? { AND: filterClauses } : {};
    const pageClauses = ks
      ? [
          ...filterClauses,
          {
            OR: [
              { createdAt: { lt: ks.createdAt } },
              { createdAt: ks.createdAt, id: { lt: ks.id } },
            ],
          },
        ]
      : filterClauses;
    const pageWhere: Prisma.DisputeWhereInput =
      pageClauses.length > 0 ? { AND: pageClauses } : {};
    const [total, rows] = await Promise.all([
      this.prisma.dispute.count({ where: filterWhere }),
      this.prisma.dispute.findMany({
        where: pageWhere,
        include: {
          booking: { include: { venue: { select: { id: true, name: true } } } },
          raisedBy: {
            select: {
              id: true,
              name: true,
              email: true,
              role: { select: { name: true } },
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
    ]);
    const items = rows.slice(0, limit);
    return {
      items,
      total,
      nextCursor:
        rows.length > limit && items.length
          ? this.keysetCursor(items[items.length - 1])
          : null,
    };
  }

  /**
   * Resolve a player report about an arena. Transitions are guarded:
   * open → reviewed/actioned/dismissed, reviewed → actioned/dismissed.
   * Terminal states can never be re-resolved (the original decision and
   * resolver are not silently overwritten). Every transition is
   * audited and the reporter is told the outcome.
   */
  async resolveVenueReport(
    adminId: string,
    reportId: string,
    body: { status: string; resolution?: string },
  ) {
    const allowed = ['reviewed', 'actioned', 'dismissed'];
    if (!allowed.includes(body.status)) {
      throw new BadRequestException('Invalid report status');
    }
    const report = await this.prisma.venueReport.findUnique({
      where: { id: reportId },
    });
    if (!report) throw new NotFoundException('Report not found');
    const terminal = ['actioned', 'dismissed'];
    const transitionOk =
      (report.status === 'open' && allowed.includes(body.status)) ||
      (report.status === 'reviewed' && terminal.includes(body.status));
    if (!transitionOk) {
      throw new BadRequestException(
        `A ${report.status} report cannot move to ${body.status}`,
      );
    }
    const resolution = body.resolution?.trim() ?? '';
    if (terminal.includes(body.status) && !resolution) {
      throw new BadRequestException('A resolution note is required to close a report');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const r = await tx.venueReport.update({
        where: { id: reportId },
        data: {
          status: body.status,
          resolution: resolution || null,
          resolvedById: adminId,
          resolvedAt: new Date(),
          // Outstanding (open/reviewed) keeps its race key; closing
          // clears it so a future report can be filed after the
          // 30-day re-file window.
          openKey: terminal.includes(body.status) ? null : report.openKey,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: adminId,
          action: `venue_report.${body.status}`,
          entity: 'venue_report',
          entityId: reportId,
        },
      });
      return r;
    });
    // An actioned fake-listing or unsafe report auto-pauses the arena:
    // investigating a report must not end with the arena still live
    // while everyone waits for a separate manual sanction.
    if (body.status === 'actioned' && ['fake_listing', 'unsafe'].includes(report.category)) {
      const venue = await this.prisma.venue.findUnique({ where: { id: report.venueId } });
      if (venue && venue.moderationStatus === 'none') {
        await this.prisma.venue.update({
          where: { id: venue.id },
          data: {
            moderationStatus: 'paused',
            moderationReason: `Auto-paused after an actioned ${report.category} report`,
            moderatedAt: new Date(),
            moderatedById: adminId,
          },
        });
        await this.audit(adminId, 'venue.moderation.paused', 'venue', venue.id, `Auto-pause from actioned ${report.category} report ${reportId}`);
        await this.bookings
          .cancelVenueUpcomingBookings(venue.id, 'the arena was paused after a player report')
          .catch(() => {});
        await this.notifications
          .pushToUser(venue.ownerId, {
            title: 'Your arena has been paused',
            body: `${venue.name} is hidden from players. Reason: auto-paused after an actioned ${report.category} report.`,
            data: { type: 'venue_moderation', venueId: venue.id },
          })
          .catch(() => {});
      }
    }
    await this.notifications
      .pushToUser(report.userId, {
        title: 'Report update',
        body: `Your report about an arena was marked ${body.status}.${resolution ? ` Resolution: ${resolution}` : ''}`,
        data: { type: 'venue_report', venueId: report.venueId },
      })
      .catch(() => {});
    return updated;
  }

  /** The admin reports queue (the panel page this feeds is future work). */
  async listVenueReports(opts: { status?: string; venueId?: string; page?: number; limit?: number }) {
    const limit = pageLimit(opts.limit, 50);
    const page = Math.max(1, opts.page ?? 1);
    const where: Prisma.VenueReportWhereInput = {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.venueId ? { venueId: opts.venueId } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.venueReport.count({ where }),
      this.prisma.venueReport.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: (page - 1) * limit,
        include: {
          venue: { select: { id: true, name: true } },
          user: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);
    return offsetPageFromDb(items, total, page, limit);
  }

  async resolveDispute(actorId: string, id: string, action: 'confirm_no_show' | 'dismiss', resolution?: string) {
    // The audit row is written inside the dispute transaction itself;
    // notifications below are best-effort and run after it commits.
    const d = await this.disputes.resolveDispute(id, action, resolution ?? '', actorId);
    const booking = await this.prisma.booking.findUnique({
      where: { id: d.bookingId },
      select: { venue: { select: { id: true, name: true, ownerId: true } } },
    });
    const note = d.resolution ? ` Resolution: ${d.resolution}` : '';
    await this.notifications
      .pushToUser(d.raisedById, {
        title: 'Dispute resolved',
        body: `Your dispute was ${d.status}.${note}`,
        data: { type: 'dispute_resolved', bookingId: d.bookingId },
      })
      .catch(() => {});
    if (booking?.venue) {
      await this.notifications
        .pushToUser(booking.venue.ownerId, {
          title: 'Dispute resolved',
          body: `A dispute on a booking at ${booking.venue.name} was ${d.status}.${note}`,
          data: { type: 'dispute_resolved', bookingId: d.bookingId, venueId: booking.venue.id },
        })
        .catch(() => {});
    }
    return d;
  }

  // ----------------------------------------------------------------- audit
  async auditLogs(entity?: string, page = 1, rawLimit?: number, from?: string, to?: string) {
    const limit = pageLimit(rawLimit, 100);
    // Server-side date filter (YYYY-MM-DD PKT days, mirroring the
    // analytics dayBounds convention: `to` is inclusive). A reversed
    // range is swapped rather than returning nothing; a malformed date
    // is a 400, not a silently ignored filter.
    const datePat = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !datePat.test(from)) || (to && !datePat.test(to))) {
      throw new BadRequestException('from/to must be YYYY-MM-DD dates');
    }
    let [f, t] = [from, to];
    if (f && t && f > t) [f, t] = [t, f];
    const createdAt: Prisma.DateTimeFilter = {};
    if (f) createdAt.gte = new Date(`${f}T00:00:00+05:00`);
    if (t) createdAt.lt = new Date(new Date(`${t}T00:00:00+05:00`).getTime() + 86400000);
    const where: Prisma.AuditLogWhereInput = {
      ...(entity ? { entity } : {}),
      ...(Object.keys(createdAt).length ? { createdAt } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        include: { actor: { select: { name: true, email: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: (Math.max(1, page) - 1) * limit,
      }),
    ]);
    return offsetPageFromDb(items, total, Math.max(1, page), limit);
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
    await this.prisma.broadcast.create({
      data: { title, body, city: city ?? null, targeted, sentById: actorId },
    });
    await this.audit(actorId, 'broadcast.send', 'broadcast', city ?? 'all');
    return { targeted };
  }

  async broadcastHistory(cursor?: string, rawLimit?: number) {
    const limit = pageLimit(rawLimit, 30);
    const ks = this.keyset(cursor);
    const rows = await this.prisma.broadcast.findMany({
      where: ks
        ? {
            OR: [
              { createdAt: { lt: ks.createdAt } },
              { createdAt: ks.createdAt, id: { lt: ks.id } },
            ],
          }
        : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor:
        rows.length > limit && items.length
          ? this.keysetCursor(items[items.length - 1])
          : null,
    };
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
    // Fetch the squad BEFORE the delete — participants cascade with
    // the post, so after it there is nobody left to notify.
    const post = await this.prisma.gamePost.findUnique({
      where: { id },
      include: {
        venue: { select: { name: true } },
        participants: { where: { userId: { not: null } }, select: { userId: true, status: true } },
      },
    });
    if (!post) throw new NotFoundException('Game post not found');
    await this.prisma.gamePost.delete({ where: { id } });
    await this.audit(actorId, 'game_post.delete', 'game_post', id);
    const recipients = new Set<string>([post.creatorId]);
    for (const p of post.participants) {
      if (p.status === 'joined' && p.userId) recipients.add(p.userId);
    }
    for (const userId of recipients) {
      await this.notifications
        .pushToUser(userId, {
          title: 'Game removed',
          body: `The ${post.sport} game at ${post.venue?.name ?? 'the arena'} was removed by an admin.`,
          data: { type: 'game_removed' },
        })
        .catch(() => {});
    }
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
    // Only live bookings can be cancelled: a completed/no-show booking
    // is history, and cancelling it would rewrite revenue and reviews.
    if (booking.status !== BookingStatus.pending && booking.status !== BookingStatus.confirmed) {
      throw new BadRequestException(
        `This booking is ${booking.status} — only pending or confirmed bookings can be cancelled`,
      );
    }
    const updated = await this.prisma.booking.update({
      where: { id },
      data: { status: BookingStatus.cancelled },
    });
    // Same cleanup as the owner cancel path: stale pending reschedules
    // must never resurrect it, its game post dies, the waitlist gets
    // the freed slot, and its promo use is refunded.
    await this.prisma.rescheduleRequest.updateMany({
      where: { bookingId: id, status: 'pending' },
      data: {
        status: 'rejected',
        reason: 'Booking is no longer active',
        decidedAt: new Date(),
      },
    });
    await this.bookings.cleanupGamePost(id, 'Booking cancelled by admin');
    await this.bookings.notifyWaitlist(booking);
    await this.bookings.releasePromo(id);
    await this.audit(actorId, 'booking.cancel', 'booking', id);
    return updated;
  }

  async forceConfirmBooking(actorId: string, id: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id } });
    if (!booking) throw new NotFoundException('Booking not found');
    // Force-confirm is a rescue for stuck pendings, not a rewrite of
    // history: a completed, cancelled, or no-show booking must never
    // come back as confirmed.
    if (booking.status !== BookingStatus.pending) {
      throw new BadRequestException(
        `This booking is ${booking.status} — only a pending booking can be force-confirmed`,
      );
    }
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
