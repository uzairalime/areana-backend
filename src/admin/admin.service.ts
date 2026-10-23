import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, UserStatus, VenueStatus, type Prisma } from '@prisma/client';
import { startOfToday } from '../common/date.util';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../common/prisma';
import { BadgesService } from '../badges/badges.service';
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
import { CreateBadgeDto, UpdateBadgeDto } from '../badges/dto';
import { SportsService } from '../sports/sports.service';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private badges: BadgesService,
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

    return {
      user: safeUser,
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

  async listUsers(q?: string, roleName?: string, status?: string, offset = 0) {
    return this.prisma.user.findMany({
      where: {
        ...(q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } : {}),
        ...(roleName ? { role: { name: roleName } } : {}),
        ...(status ? { status: status as UserStatus } : {}),
      },
      include: { role: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      skip: Math.max(0, offset),
    });
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
      totals,
      venues: rows,
      staff,
      activity,
      duplicatePhoneAccounts,
    };
  }

  async pendingVenues() {
    const venues = await this.prisma.venue.findMany({
      where: { status: VenueStatus.pending },
      include: {
        owner: { select: { name: true, email: true, phone: true } },
        // Active courts ride along so the approvals card can mirror the
        // venues-list card (court count + sports) without extra calls.
        courts: { where: { isActive: true }, select: { id: true, sport: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return venues.map((v) => ({
      ...v,
      readiness: venueReadiness(v, v.courts.length),
    }));
  }

  async approveVenue(actorId: string, venueId: string) {
    const existing = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!existing) throw new NotFoundException('Venue not found');
    const courts = await this.prisma.court.count({
      where: { venueId, isActive: true },
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
    const ownerRole = await this.prisma.role.findFirst({ where: { name: 'owner' } });
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
      // Same default staff-role allowances the owner panel grants.
      const allowed = await tx.role.findMany({ where: { scope: 'arena' } });
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
  async listVenuesAdmin(opts?: { sort?: string; range?: string }) {
    const venues = await this.prisma.venue.findMany({
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
      this.prisma.venueReport.groupBy({
        by: ['venueId'],
        where: { status: 'open' },
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
        readiness: venueReadiness(v, v.courts.filter((c) => c.isActive).length),
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
    return out;
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
          where: { venueId, status: 'open' },
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
        venue.courts.filter((c) => c.isActive).length,
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
  async setCourtLimit(actorId: string, venueId: string, limit: number | null) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
      throw new BadRequestException('Court limit must be between 1 and 500, or empty for the plan default');
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
      limit === null ? 'limit: plan default' : `limit: ${limit}`,
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
  async setStaffLimit(actorId: string, venueId: string, limit: number | null) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > 500)) {
      throw new BadRequestException('Team seat limit must be between 0 and 500, or empty for the plan default');
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
      limit === null ? 'limit: plan default' : `limit: ${limit}`,
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
   * Super-admin edit of ANY arena's data. Unlike owner edits, an admin
   * edit never sends a live venue back to pending — the admin IS the
   * approver. Sports are validated against the catalog.
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
    if (changed.length > 0) {
      await this.notifications
        .pushToUser(venue.ownerId, {
          title: 'Arena details updated',
          body: `Areana admin updated "${venue.name}" (${changed.join(', ')}).`,
          data: { type: 'venue_edited', venueId },
        })
        .catch(() => {});
    }
    const activeCourts = await this.prisma.court.count({ where: { venueId, isActive: true } });
    return { ...updated, readiness: venueReadiness(updated, activeCourts) };
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
    const titles: Record<string, string> = {
      paused: 'Your arena has been paused',
      blocked: 'Your arena has been blocked',
      disabled: 'Your arena has been disabled',
      none: 'Your arena is visible again',
    };
    await this.notifications
      .pushToUser(venue.ownerId, {
        title: titles[status],
        body:
          status === 'none'
            ? `${venue.name} is back on Areana and visible to players.`
            : `${venue.name} is hidden from players. Reason: ${reason}`,
        data: { type: 'venue_moderation', venueId },
      })
      .catch(() => {});
    return updated;
  }

  // -------------------------------------------------------- court approvals
  async pendingCourts() {
    return this.prisma.court.findMany({
      where: { status: 'pending' },
      include: {
        venue: {
          select: {
            id: true,
            name: true,
            city: true,
            owner: { select: { name: true, email: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async approveCourt(actorId: string, courtId: string) {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: { venue: { select: { name: true, ownerId: true } } },
    });
    if (!court) throw new NotFoundException('Court not found');
    const updated = await this.prisma.court.update({
      where: { id: courtId },
      data: { status: 'approved' },
    });
    await this.audit(actorId, 'court.approve', 'court', courtId);
    await this.notifications
      .pushToUser(court.venue.ownerId, {
        title: 'Court approved',
        body: `${court.name} at ${court.venue.name} is live — players can now book it.`,
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
    const updated = await this.prisma.court.update({
      where: { id: courtId },
      data: { status: 'rejected' },
    });
    await this.audit(actorId, 'court.reject', 'court', courtId);
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
    await this.assertCourtNameFree(venueId, dto.name);
    const open0 = dto.openMinutes ?? 360;
    const close0 = dto.closeMinutes ?? 1380;
    if (close0 - open0 < 60 || close0 - open0 > 1200) {
      throw new BadRequestException('Court hours must span between 1 and 20 hours');
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
    const updated = await this.prisma.court.update({ where: { id: courtId }, data });
    await this.syncVenueSports(court.venueId);
    await this.audit(
      actorId,
      'court.update',
      'court',
      courtId,
      `${court.name}: ${Object.keys(dto).join(', ')}`,
    );
    await this.notifications
      .pushToUser(court.venue.ownerId, {
        title: 'Court updated',
        body: `Areana admin updated "${court.name}" at "${court.venue.name}".`,
        data: { type: 'court_updated', venueId: court.venueId },
      })
      .catch(() => {});
    return updated;
  }

  async deleteCourt(actorId: string, courtId: string) {
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: { venue: { select: { name: true, ownerId: true } } },
    });
    if (!court) throw new NotFoundException('Court not found');
    const live = await this.prisma.booking.count({
      where: { courtId, status: { not: BookingStatus.cancelled } },
    });
    if (live > 0) {
      throw new ConflictException(
        `This court has ${live} booking(s) on record — deactivate it instead of deleting it`,
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
    await this.prisma.$transaction(async (tx) => {
      // Only cancelled bookings can remain at this point; they carry no
      // disputes (checked above) and are removed with the court.
      await tx.booking.deleteMany({ where: { courtId, status: BookingStatus.cancelled } });
      await tx.slotWaitlist.deleteMany({ where: { courtId } });
      await tx.court.delete({ where: { id: courtId } });
    });
    // The court's photo files go with it (single-photo deletes already
    // clean up; a whole-court delete must not leak the files).
    for (const entry of this.courtPhotoEntries(court)) {
      await this.storage.deleteImage(entry.url);
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
    return this.prisma.venue.update({
      where: { id: venueId },
      data: { photos: entries },
    });
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
    return this.prisma.venue.update({
      where: { id: venueId },
      data: { images: entries.map((e) => e.url), photos: entries },
    });
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
    const plan = await this.plans.updatePlan(id, dto);
    await this.audit(actorId, 'plan.update', 'plan', id);
    return plan;
  }

  async deletePlan(actorId: string, id: string) {
    const result = await this.plans.deletePlan(id);
    await this.audit(actorId, 'plan.delete', 'plan', id);
    return result;
  }

  /** All approved venues with their plan + billing state (Plans page). */
  async listVenueBilling() {
    const venues = await this.prisma.venue.findMany({
      where: { status: VenueStatus.approved },
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
    return out;
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

  async assignVenuePlan(actorId: string, venueId: string, planId: string, restartBilling = false) {
    const venue = await this.plans.assignPlan(venueId, planId, restartBilling);
    await this.audit(actorId, 'venue.plan.assign', 'venue', venueId);
    return { venue, billing: await this.plans.billingSummary(venue) };
  }

  async extendVenueFree(actorId: string, venueId: string, months: number) {
    const venue = await this.plans.extendFree(venueId, months);
    await this.audit(actorId, 'venue.billing.extend_free', 'venue', venueId);
    return { venue, billing: await this.plans.billingSummary(venue) };
  }

  async markVenuePaid(
    actorId: string,
    venueId: string,
    opts?: { method?: string; note?: string },
  ) {
    const venue = await this.plans.markPaid(venueId, actorId, opts);
    await this.audit(actorId, 'venue.billing.mark_paid', 'venue', venueId);
    return { venue, billing: await this.plans.billingSummary(venue) };
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
    return this.prisma.promoCode.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        venue: { select: { id: true, name: true } },
      },
    });
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

  /** Resolve a player report about an arena: reviewed | actioned | dismissed. */
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
    return this.prisma.venueReport.update({
      where: { id: reportId },
      data: {
        status: body.status,
        resolution: body.resolution?.trim() || null,
        resolvedById: adminId,
        resolvedAt: new Date(),
      },
    });
  }

  resolveDispute(actorId: string, id: string, action: 'confirm_no_show' | 'dismiss' | 'credit', resolution?: string) {
    return this.disputes.resolveDispute(id, action, resolution ?? '', actorId).then(async (d) => {
      await this.audit(actorId, 'dispute.resolve', 'dispute', id);
      return d;
    });
  }

  // ----------------------------------------------------------------- audit
  auditLogs(entity?: string, take = 100, offset = 0) {
    return this.prisma.auditLog.findMany({
      where: entity ? { entity } : {},
      include: { actor: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take,
      skip: Math.max(0, offset),
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
    await this.prisma.broadcast.create({
      data: { title, body, city: city ?? null, targeted, sentById: actorId },
    });
    await this.audit(actorId, 'broadcast.send', 'broadcast', city ?? 'all');
    return { targeted };
  }

  broadcastHistory() {
    return this.prisma.broadcast.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
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
