import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, VenueStatus, type Prisma, type PromoCode } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthUser } from '../common/auth';
import { PrismaService } from '../common/prisma';
import { encodeCursor, keysetWhere, offsetPage, offsetPageFromDb, pageLimit } from '../common/pagination';
import { BookingsService } from '../bookings/bookings.service';
import { StorageService } from '../storage/storage.service';
import { ReviewsService } from '../reviews/reviews.service';
import { NotificationsService } from '../notifications/notifications.service';
import { isSameDay, minutesSinceMidnight, parseDateOnly, startOfToday } from '../common/date.util';
import { CourtsService, toYmd } from '../courts/courts.service';
import { PlansService } from '../plans/plans.service';
import { ARENA_ROLE_PERMISSIONS } from '../common/permissions';
import type { CreateMyPromoDto, CreateMyRoleDto, UpdateMyPromoDto, UpdateMyRoleDto } from './dto';
import {
  assertBookingWindow,
  assertPakistanCoords,
  photoEntriesOf,
  venueReadiness,
  withSportTag,
} from '../venues/venue-readiness';
import { SportsService } from '../sports/sports.service';
import { AmenitiesService } from '../amenities/amenities.service';
import {
  BookingsQueryDto,
  CreateBlockDto,
  CreateClosureDto,
  CreateCourtDto,
  CreatePriceWindowDto,
  CreateRecurringBlockDto,
  SetWeeklyHoursDto,
  CreateStaffDto,
  CreateVenueDto,
  UpdateCourtDto,
  UpdateVenueDto,
  WalkInDto,
} from './dto';

@Injectable()
export class OwnerService {
  constructor(
    private prisma: PrismaService,
    private bookingOps: BookingsService,
    private courtsSvc: CourtsService,
    private storage: StorageService,
    private reviewOps: ReviewsService,
    private notifications: NotificationsService,
    private plans: PlansService,
    private sports: SportsService,
    private amenities: AmenitiesService,
  ) {}

  // ------------------------------------------------------------ access scope
  /**
   * Venue ids the user may operate: owned venues PLUS staff-linked
   * venues. The old code returned ONLY owned venues for anyone holding
   * venues.manage — an owner who also staffed another arena (or a
   * staffer granted venues.manage) silently lost their linked venues.
   */
  async venueIds(user: AuthUser): Promise<string[]> {
    const ids = new Set<string>();
    const owned = await this.prisma.venue.findMany({
      where: { ownerId: user.id },
      select: { id: true },
    });
    for (const v of owned) ids.add(v.id);
    const links = await this.prisma.venueStaff.findMany({
      where: { userId: user.id },
      select: { venueId: true },
    });
    for (const l of links) ids.add(l.venueId);
    return [...ids];
  }

  async assertVenue(user: AuthUser, venueId: string) {
    const ids = await this.venueIds(user);
    if (!ids.includes(venueId)) throw new ForbiddenException('Not your venue');
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    return venue;
  }

  /**
   * Billing/revenue visibility: a venue's owner always sees its money;
   * a staff-linked venue only when the caller holds billing.view.
   * Owners are covered by the ownership rule, so existing owner roles
   * that lack the new key do not break — and staff without the key
   * still see bookings and occupancy, just not money.
   */
  private async moneyVenueIds(user: AuthUser): Promise<string[]> {
    const owned = await this.prisma.venue.findMany({
      where: { ownerId: user.id },
      select: { id: true },
    });
    const ids = new Set(owned.map((v) => v.id));
    if (user.permissions.includes('billing.view') || user.permissions.includes('*')) {
      const links = await this.prisma.venueStaff.findMany({
        where: { userId: user.id },
        select: { venueId: true },
      });
      for (const l of links) ids.add(l.venueId);
    }
    return [...ids];
  }

  private async ownedBooking(user: AuthUser, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
    await this.assertVenue(user, booking.venueId);
    return booking;
  }

  // -------------------------------------------------------------- dashboard
  async dashboard(user: AuthUser, venueId?: string, dateStr?: string) {
    const ids = venueId ? [(await this.assertVenue(user, venueId)).id] : await this.venueIds(user);
    const date = dateStr ? parseDateOnly(dateStr) : startOfToday();
    const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);

    // Revenue is masked to money-visible venues (owned, or linked +
    // billing.view); bookings and occupancy stay visible for all
    // in-scope venues.
    const moneyIds = new Set(await this.moneyVenueIds(user));
    const [todayBookings, monthBookings, courts] = await Promise.all([
      this.prisma.booking.findMany({
        where: { venueId: { in: ids }, date },
        include: {
          court: { select: { name: true, sport: true } },
          user: { select: { name: true, phone: true } },
        },
        orderBy: { startMinutes: 'asc' },
      }),
      this.prisma.booking.findMany({
        where: {
          venueId: { in: [...moneyIds] },
          date: { gte: monthStart },
          status: { in: [BookingStatus.confirmed, BookingStatus.completed] },
        },
        select: { totalPrice: true },
      }),
      this.prisma.court.findMany({
        where: { venueId: { in: ids }, isActive: true },
        select: { openMinutes: true, closeMinutes: true },
      }),
    ]);

    const revenueToday = todayBookings
      .filter(
        (b) =>
          moneyIds.has(b.venueId) &&
          (b.status === BookingStatus.confirmed || b.status === BookingStatus.completed),
      )
      .reduce((s, b) => s + Number(b.totalPrice), 0);
    const revenueMonth = monthBookings.reduce((s, b) => s + Number(b.totalPrice), 0);
    const totalSlotMin = courts.reduce((s, c) => s + Math.max(0, c.closeMinutes - c.openMinutes), 0);
    const bookedMin = todayBookings
      .filter((b) => b.status === BookingStatus.confirmed || b.status === BookingStatus.pending)
      .reduce((s, b) => s + (b.endMinutes - b.startMinutes), 0);

    return {
      date: date.toISOString().slice(0, 10),
      todayBookings,
      pendingCount: todayBookings.filter((b) => b.status === BookingStatus.pending).length,
      confirmedCount: todayBookings.filter((b) => b.status === BookingStatus.confirmed).length,
      revenueToday,
      revenueMonth,
      occupancyPct: totalSlotMin > 0 ? Math.round((bookedMin / totalSlotMin) * 100) : 0,
    };
  }

  // ---------------------------------------------------------------- venues
  async listMyVenues(user: AuthUser, cursor?: string, rawLimit?: number) {
    const limit = pageLimit(rawLimit, 30);
    const ids = await this.venueIds(user);
    const venues = await this.prisma.venue.findMany({
      where: { id: { in: ids }, ...keysetWhere(cursor, 'createdAt', 'desc') },
      include: { _count: { select: { courts: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const pageRows = venues.slice(0, limit);
    const out = [];
    for (const v of pageRows) {
      const { limit } = await this.plans.effectiveCourtLimit(v.id);
      // Rejected courts don't consume quota (matches createCourt).
      const used = await this.prisma.court.count({
        where: { venueId: v.id, status: { not: 'rejected' } },
      });
      out.push({ ...v, courtLimit: { limit, used } });
    }
    return {
      items: out,
      nextCursor:
        venues.length > limit && out.length
          ? encodeCursor(out[out.length - 1].createdAt, out[out.length - 1].id)
          : null,
    };
  }

  async createVenue(user: AuthUser, dto: CreateVenueDto) {
    const limit = await this.plans.venueLimitForOwner(user.id);
    if (limit !== null) {
      const count = await this.prisma.venue.count({ where: { ownerId: user.id } });
      if (count >= limit) {
        throw new ForbiddenException(
          `Your plan allows ${limit} venue(s). Ask Areana about upgrading to add more.`,
        );
      }
    }
    assertPakistanCoords(dto.lat, dto.lng);
    const sports = await this.sports.normalizeSports(dto.sports ?? []);
    const amenities = await this.amenities.normalizeAmenities(dto.amenities ?? []);
    const venue = await this.prisma.venue.create({
      data: {
        ownerId: user.id,
        name: dto.name,
        address: dto.address,
        city: dto.city,
        phone: dto.phone,
        lat: dto.lat,
        lng: dto.lng,
        sports,
        amenities,
        status: VenueStatus.draft,
      },
    });
    // Default staff roles: platform arena roles only. Owner-created
    // roles belong to their own owner — attaching them here would let
    // one owner's role silently govern another owner's venue.
    const allowed = await this.prisma.role.findMany({
      where: { scope: 'arena', ownerId: null },
    });
    if (allowed.length > 0) {
      await this.prisma.venueAllowedRole.createMany({
        data: allowed.map((r) => ({ venueId: venue.id, roleId: r.id })),
        skipDuplicates: true,
      });
    }
    return venue;
  }

  /**
   * Soft duplicate check for the owner form: another arena with the same
   * name in the same city (any owner, not archived). Warning only —
   * legit branches share names, so creation is never blocked.
   */
  async duplicateVenueCheck(user: AuthUser, name?: string, city?: string, excludeId?: string) {
    const n = (name ?? '').trim();
    const c = (city ?? '').trim();
    if (!n || !c) return { duplicates: [] };
    const rows = await this.prisma.venue.findMany({
      where: {
        archivedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        name: { equals: n, mode: 'insensitive' },
        city: { equals: c, mode: 'insensitive' },
      },
      select: { id: true, name: true, city: true, status: true, ownerId: true },
      take: 5,
    });
    // The check exists to warn about name clashes, not to leak other
    // owners' pipeline state: status is shown only for the caller's
    // own venues (or to '*' platform callers).
    const canSeeStatus = user.permissions.includes('*');
    const duplicates = rows.map(({ ownerId, status, ...rest }) => ({
      ...rest,
      ...(ownerId === user.id || canSeeStatus ? { status } : {}),
    }));
    return { duplicates };
  }

  async updateVenue(user: AuthUser, venueId: string, dto: UpdateVenueDto) {
    const scoped = await this.assertVenue(user, venueId);
    if (!user.permissions.includes('venues.manage')) {
      throw new ForbiddenException('Only the owner can edit venue settings');
    }
    // venues.manage is not an owner proxy: a staffer holding the key
    // (or an owner staffing another arena) must not edit someone
    // else's venue. Identity edits are owner-only, by ownership.
    if (scoped.ownerId !== user.id) {
      throw new ForbiddenException('Only the venue owner can edit venue settings');
    }
    // Identity edits on a LIVE venue go back through approval: approvals
    // guard what a venue claims to be, so a name/address/city/pin change
    // can't silently rewrite a reviewed listing. Operational fields
    // (phone, description) stay instant — but an amenities/sports edit
    // that breaks the go-live checklist also drops the venue to
    // pending (see the readiness drop below), because the listing
    // would no longer meet the bar players were shown.
    const current = await this.prisma.venue.findUniqueOrThrow({ where: { id: venueId } });
    if (dto.minAdvanceMinutes !== undefined || dto.maxAdvanceDays !== undefined) {
      assertBookingWindow(
        dto.minAdvanceMinutes ?? current.minAdvanceMinutes,
        dto.maxAdvanceDays ?? current.maxAdvanceDays,
      );
    }
    const identityChanged =
      (dto.name !== undefined && dto.name !== current.name) ||
      (dto.address !== undefined && dto.address !== current.address) ||
      (dto.city !== undefined && dto.city !== current.city) ||
      (dto.lat !== undefined && dto.lat !== current.lat) ||
      (dto.lng !== undefined && dto.lng !== current.lng);
    const data: Prisma.VenueUpdateInput = { ...dto };
    if (dto.sports !== undefined) {
      data.sports = await this.sports.normalizeSports(dto.sports, {
        grandfathered: current.sports,
      });
    }
    if (dto.lat !== undefined || dto.lng !== undefined) {
      assertPakistanCoords(dto.lat ?? current.lat, dto.lng ?? current.lng);
    }
    if (dto.amenities !== undefined) {
      data.amenities = await this.amenities.normalizeAmenities(dto.amenities, {
        grandfathered: current.amenities,
      });
    }
    let backToPending = false;
    if (identityChanged && current.status === VenueStatus.approved) {
      data.status = VenueStatus.pending;
      backToPending = true;
    }
    const venue = await this.prisma.venue.update({ where: { id: venueId }, data });
    // Amenity/sport edits can break the go-live checklist (empty
    // amenities, or a sport with no tagged photo left): an approved
    // venue that no longer qualifies goes back to pending, surfaced
    // through the same flag as the identity drop.
    if (
      venue.status === VenueStatus.approved &&
      (dto.amenities !== undefined || dto.sports !== undefined)
    ) {
      const dropped = await this.dropVenueIfUnready(venueId);
      if (dropped) {
        backToPending = true;
        return { ...(await this.prisma.venue.findUniqueOrThrow({ where: { id: venueId } })), backToPending };
      }
    }
    return { ...venue, backToPending };
  }

  /**
   * Re-run the go-live checklist after a photo/amenity/sport edit.
   * Returns true when an approved venue was dropped to pending.
   * Adding a photo or reordering never breaks readiness, so those
   * paths skip this.
   */
  private async dropVenueIfUnready(venueId: string): Promise<boolean> {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue || venue.status !== VenueStatus.approved) return false;
    const courts = await this.prisma.court.count({
      where: { venueId, isActive: true, status: 'approved' },
    });
    if (venueReadiness(venue, courts).ready) return false;
    await this.prisma.venue.update({
      where: { id: venueId },
      data: { status: VenueStatus.pending },
    });
    return true;
  }

  async submitVenue(user: AuthUser, venueId: string) {
    const venue = await this.assertVenue(user, venueId);
    if (!user.permissions.includes('venues.manage')) {
      throw new ForbiddenException('Only the owner can submit a venue');
    }
    // Same owner-proxy fix as updateVenue: venues.manage alone must
    // not let a staffer submit another owner's venue.
    if (venue.ownerId !== user.id) {
      throw new ForbiddenException('Only the venue owner can submit a venue');
    }
    // Only a draft or a rejected venue can (re-)enter the queue: a live
    // venue must not delist itself by accident, and a suspended or
    // archived venue must not self-reinstate through this path.
    if (venue.archivedAt) {
      throw new BadRequestException('This arena is archived — restore it before submitting');
    }
    if (venue.status !== VenueStatus.draft && venue.status !== VenueStatus.rejected) {
      throw new BadRequestException(
        `This arena is ${venue.status} — only a draft or rejected arena can be submitted`,
      );
    }
    // Readiness counts bookable courts only: a pending court is not
    // bookable, so it must not satisfy the "at least one court" bar.
    const courts = await this.prisma.court.count({
      where: { venueId, isActive: true, status: 'approved' },
    });
    const readiness = venueReadiness(venue, courts);
    if (!readiness.ready) {
      throw new BadRequestException(
        `This venue isn't ready to submit yet: ${readiness.missing.join('; ')}`,
      );
    }
    return this.prisma.venue.update({
      where: { id: venueId },
      data: { status: VenueStatus.pending, rejectionReason: null },
    });
  }

  /**
   * Rich photo entries aligned to `venue.images` order. Photos uploaded
   * before the media pass have no stored entry — they get a bare { url }
   * here (gradient placeholder in the apps) and gain a blurhash only if
   * re-uploaded. `images` (plain URLs) stays the order source of truth.
   */
  private photoEntries(venue: { images: string[]; photos: unknown }) {
    return photoEntriesOf(venue);
  }

  async addVenueImage(user: AuthUser, venueId: string, file: Express.Multer.File, sport?: string) {
    const venue = await this.assertVenue(user, venueId);
    const photo = await this.storage.saveVenueImage(venueId, file);
    const entries = [
      ...this.photoEntries(venue),
      { ...photo, sport: sport && sport.trim() ? sport.trim() : undefined },
    ];
    return this.prisma.venue.update({
      where: { id: venueId },
      data: { images: entries.map((e) => e.url), photos: entries },
    });
  }

  /** Tag (or untag) one photo with a sport — every sport a venue offers
   * needs at least one tagged photo before the venue can go live. */
  async tagVenueImage(user: AuthUser, venueId: string, url: string, sport: string | null) {
    const venue = await this.assertVenue(user, venueId);
    const entries = withSportTag(this.photoEntries(venue), url, sport);
    await this.prisma.venue.update({
      where: { id: venueId },
      data: { photos: entries },
    });
    // Untagging can break the per-sport photo rule for an approved venue.
    await this.dropVenueIfUnready(venueId);
    return this.prisma.venue.findUniqueOrThrow({ where: { id: venueId } });
  }

  /** Retire a venue: hidden from players everywhere, history kept. */
  async archiveVenue(user: AuthUser, venueId: string) {
    const venue = await this.assertVenue(user, venueId);
    // Archiving hides the arena everywhere at once — it must not strand
    // players holding live bookings (same policy as court delete).
    const upcoming = await this.prisma.booking.count({
      where: {
        venueId,
        status: { in: ['pending', 'confirmed'] },
        date: { gte: startOfToday() },
      },
    });
    if (upcoming > 0) {
      throw new ConflictException(
        `This arena has ${upcoming} upcoming booking(s) — cancel or complete them before archiving`,
      );
    }
    return this.prisma.venue.update({
      where: { id: venue.id },
      data: { archivedAt: new Date() },
    });
  }

  /** Court names are how players and staff tell courts apart — keep them unique per arena. */
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

  /**
   * While an arena is sanctioned or its billing is paused, the owner can
   * still reject/cancel (cleanup), but cannot CONFIRM new bookings —
   * confirming creates commitments at an arena players cannot see.
   */
  private async assertVenueActionable(venueId: string) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { moderationStatus: true, billingPaused: true },
    });
    if (!venue) return;
    if (venue.moderationStatus !== 'none') {
      throw new ForbiddenException(
        'This arena is under a platform sanction — bookings cannot be confirmed until the sanction is lifted',
      );
    }
    if (venue.billingPaused) {
      throw new ForbiddenException(
        "This arena's billing is paused — resolve the billing to confirm bookings",
      );
    }
  }

  async unarchiveVenue(user: AuthUser, venueId: string) {
    const venue = await this.assertVenue(user, venueId);
    const restored = await this.prisma.venue.update({
      where: { id: venue.id },
      data: { archivedAt: null },
    });
    // A live venue that decayed while archived (photos/amenities
    // stripped, courts removed) must not silently return to discovery:
    // it drops back to pending for a fresh approval decision.
    if (venue.status === VenueStatus.approved) {
      const courts = await this.prisma.court.count({
        where: { venueId, isActive: true, status: 'approved' },
      });
      const readiness = venueReadiness(restored, courts);
      if (!readiness.ready) {
        return this.prisma.venue.update({
          where: { id: venue.id },
          data: { status: VenueStatus.pending },
        });
      }
    }
    return restored;
  }

  async removeVenueImage(user: AuthUser, venueId: string, url: string) {
    const venue = await this.assertVenue(user, venueId);
    await this.storage.deleteImage(url);
    const entries = this.photoEntries(venue).filter((e) => e.url !== url);
    await this.prisma.venue.update({
      where: { id: venueId },
      data: { images: entries.map((e) => e.url), photos: entries },
    });
    // Removing a photo can drop an approved venue below 4 photos or
    // remove the only tagged photo for a sport.
    await this.dropVenueIfUnready(venueId);
    return this.prisma.venue.findUniqueOrThrow({ where: { id: venueId } });
  }

  /** Reorder a venue's photos (the first photo is the cover everywhere). */
  async reorderVenueImages(user: AuthUser, venueId: string, urls: string[]) {
    const venue = await this.assertVenue(user, venueId);
    const entries = this.photoEntries(venue);
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

  // ---------------------------------------------------------------- courts
  async courts(user: AuthUser, venueId: string) {
    await this.assertVenue(user, venueId);
    return this.prisma.court.findMany({ where: { venueId }, orderBy: { name: 'asc' } });
  }

  /**
   * Overnight courts: a close time at or before the open time means the
   * court closes after midnight — stored as minutes past 1440 (e.g.
   * 02:00 close = 1560). Max 20 open hours, spill capped at 06:00.
   */
  private normalizeCourtHours(openMinutes: number, closeMinutes: number) {
    let close = closeMinutes;
    if (close <= openMinutes) close += 1440;
    if (close - openMinutes > 1200 || close > 1800) {
      throw new BadRequestException(
        'A court can be open at most 20 hours, closing by 06:00 next day',
      );
    }
    return close;
  }

  /**
   * venue.sports is denormalized from the venue's ACTIVE courts — it
   * drives the player web's sport filter and chips. It used to be set
   * once from the create form and never updated, so it drifted from
   * reality the moment courts changed.
   */
  private async syncVenueSports(venueId: string) {
    const [courts, venue] = await Promise.all([
      this.prisma.court.findMany({
        where: { venueId, isActive: true },
        select: { sport: true },
      }),
      this.prisma.venue.findUnique({ where: { id: venueId }, select: { sports: true } }),
    ]);
    // Union, never shrink: a sport the venue already lists (e.g. one the
    // admin set, or whose court was deactivated) must not silently vanish
    // because a court was added or edited.
    const sports = [...new Set([...(venue?.sports ?? []), ...courts.map((c) => c.sport)])];
    await this.prisma.venue.update({ where: { id: venueId }, data: { sports } });
  }

  async createCourt(user: AuthUser, venueId: string, dto: CreateCourtDto) {
    const venue = await this.assertVenue(user, venueId);
    // Courts for a dead venue would pile into the approvals queue and
    // could be approved into nothing bookable.
    if (venue.archivedAt || venue.status === VenueStatus.suspended || venue.status === VenueStatus.rejected) {
      throw new BadRequestException(
        'Courts cannot be added while the arena is archived, suspended, or rejected',
      );
    }
    await this.assertCourtNameFree(venueId, dto.name);
    const data = { ...dto, sport: await this.sports.normalizeSport(dto.sport) };
    if (data.openMinutes != null && data.closeMinutes != null) {
      data.closeMinutes = this.normalizeCourtHours(data.openMinutes, data.closeMinutes);
    }
    const { limit } = await this.plans.effectiveCourtLimit(venueId);
    // The venue row lock serializes creates per arena, so two
    // simultaneous creates can't both pass the limit check. Only
    // ACTIVE, non-rejected courts consume quota — a deactivated court
    // frees its slot, and a rejected one never took one.
    const court = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR UPDATE`;
      if (limit !== null) {
        const count = await tx.court.count({
          where: { venueId, isActive: true, status: { not: 'rejected' } },
        });
        if (count >= limit) {
          throw new ForbiddenException(
            `This arena's court limit is ${limit}. Ask Areana about raising it.`,
          );
        }
      }
      // New courts need super-admin approval before players can see/book them.
      return tx.court.create({ data: { venueId, ...data, status: 'pending' } });
    });
    await this.syncVenueSports(venueId);
    return court;
  }

  async updateCourt(user: AuthUser, courtId: string, dto: UpdateCourtDto) {
    const court = await this.prisma.court.findUnique({ where: { id: courtId } });
    if (!court) throw new NotFoundException('Court not found');
    await this.assertVenue(user, court.venueId);
    if (dto.name !== undefined && dto.name !== court.name) {
      await this.assertCourtNameFree(court.venueId, dto.name, courtId);
    }
    // Deactivation refuses upcoming bookings, like archiveVenue:
    // switching a court off with games still booked would strand
    // players who paid for a slot that no longer exists. (The panel
    // warns before save; the API is the enforcement.)
    if (dto.isActive === false && court.isActive) {
      const upcoming = await this.prisma.booking.count({
        where: {
          courtId,
          date: { gte: startOfToday() },
          status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
        },
      });
      if (upcoming > 0) {
        throw new ConflictException(
          `${upcoming} upcoming booking(s) still sit on this court — move or cancel them first`,
        );
      }
    }
    const data = { ...dto };
    if (data.openMinutes != null || data.closeMinutes != null) {
      data.closeMinutes = this.normalizeCourtHours(
        data.openMinutes ?? court.openMinutes,
        data.closeMinutes ?? court.closeMinutes,
      );
      // Same guard the admin path has: shrinking hours must not strand
      // confirmed upcoming bookings outside the court's day.
      const newOpen = data.openMinutes ?? court.openMinutes;
      const stranded = await this.prisma.booking.count({
        where: {
          courtId,
          status: 'confirmed',
          date: { gte: startOfToday() },
          OR: [
            { startMinutes: { lt: newOpen } },
            { endMinutes: { gt: data.closeMinutes } },
          ],
        },
      });
      if (stranded > 0) {
        throw new ConflictException(
          `${stranded} upcoming booking(s) fall outside the new hours — move or cancel them first`,
        );
      }
    }
    // Editing a rejected court re-submits it for approval. An approved
    // court whose price, hours, or slot length actually changes
    // likewise goes back into the review queue — players were shown
    // the old terms. (Sport is not owner-editable — the admin path
    // covers its re-queue.) isActive toggles, name, size, surface,
    // and indoor do not re-queue.
    const requeueFields = ['pricePerHour', 'openMinutes', 'closeMinutes', 'slotMinutes'] as const;
    const requeue =
      court.status === 'rejected' ||
      (court.status === 'approved' &&
        requeueFields.some(
          (f) => (data as Record<string, unknown>)[f] !== undefined && (data as Record<string, unknown>)[f] !== court[f],
        ));
    const updated = await this.prisma.court.update({
      where: { id: courtId },
      data: requeue ? { ...data, status: 'pending', rejectionReason: null } : data,
    });
    await this.syncVenueSports(court.venueId);
    return updated;
  }

  // ---------------------------------------------------------------- blocks
  async blocks(user: AuthUser, venueId: string, dateStr?: string) {
    await this.assertVenue(user, venueId);
    return this.prisma.slotBlock.findMany({
      where: {
        court: { venueId },
        ...(dateStr ? { date: parseDateOnly(dateStr) } : { date: { gte: startOfToday() } }),
      },
      include: { court: { select: { name: true } } },
      orderBy: [{ date: 'asc' }, { startMinutes: 'asc' }],
    });
  }

  async createBlock(user: AuthUser, dto: CreateBlockDto) {
    const court = await this.prisma.court.findUnique({ where: { id: dto.courtId } });
    if (!court) throw new NotFoundException('Court not found');
    await this.assertVenue(user, court.venueId);
    if (dto.endMinutes <= dto.startMinutes) {
      throw new BadRequestException('endMinutes must be after startMinutes');
    }
    return this.prisma.slotBlock.create({
      data: {
        courtId: dto.courtId,
        date: parseDateOnly(dto.date),
        startMinutes: dto.startMinutes,
        endMinutes: dto.endMinutes,
        reason: dto.reason,
      },
    });
  }

  async deleteBlock(user: AuthUser, blockId: string) {
    const block = await this.prisma.slotBlock.findUnique({
      where: { id: blockId },
      include: { court: { select: { venueId: true } } },
    });
    if (!block) throw new NotFoundException('Block not found');
    await this.assertVenue(user, block.court.venueId);
    return this.prisma.slotBlock.delete({ where: { id: blockId } });
  }

  // ------------------------------------------------- availability manager
  private async assertCourt(user: AuthUser, courtId: string) {
    const court = await this.prisma.court.findUnique({ where: { id: courtId } });
    if (!court) throw new NotFoundException('Court not found');
    await this.assertVenue(user, court.venueId);
    return court;
  }

  private conflictView(b: {
    id: string;
    date: Date;
    startMinutes: number;
    endMinutes: number;
    status: string;
    guestName: string | null;
    user: { name: string } | null;
  }) {
    return {
      bookingId: b.id,
      date: toYmd(b.date),
      startMinutes: b.startMinutes,
      endMinutes: b.endMinutes,
      status: b.status,
      player: b.user?.name ?? (b.guestName ? `${b.guestName} (walk-in)` : 'Guest'),
    };
  }

  /** Weekly template + recurring blocks for one court (owner view). */
  async courtAvailabilityRules(user: AuthUser, courtId: string) {
    const court = await this.assertCourt(user, courtId);
    const [rows, recurringBlocks, priceWindows] = await Promise.all([
      this.prisma.courtWeeklyWindow.findMany({
        where: { courtId },
        orderBy: [{ weekday: 'asc' }, { startMinutes: 'asc' }],
      }),
      this.prisma.recurringBlock.findMany({
        where: { courtId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.courtPriceWindow.findMany({
        where: { courtId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const weekly = Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      windows: rows
        .filter((r) => r.weekday === weekday)
        .map((r) => ({ startMinutes: r.startMinutes, endMinutes: r.endMinutes })),
    }));
    return {
      courtId,
      usesWeeklyTemplate: rows.length > 0,
      defaultWindow: { startMinutes: court.openMinutes, endMinutes: court.closeMinutes },
      weekly,
      recurringBlocks: recurringBlocks.map((r) => ({
        ...r,
        startsOn: r.startsOn ? toYmd(r.startsOn) : null,
        endsOn: r.endsOn ? toYmd(r.endsOn) : null,
      })),
      priceWindows: priceWindows.map((r) => ({
        ...r,
        pricePerHour: Number(r.pricePerHour),
        startsOn: r.startsOn ? toYmd(r.startsOn) : null,
        endsOn: r.endsOn ? toYmd(r.endsOn) : null,
      })),
    };
  }

  /**
   * Create a peak/off-peak price window. A slot can carry only one
   * special rate, so windows must not overlap (same weekday + minutes +
   * intersecting date ranges). Existing bookings are unaffected — their
   * prices were snapshotted at booking time.
   */
  async createPriceWindow(user: AuthUser, courtId: string, dto: CreatePriceWindowDto) {
    const court = await this.assertCourt(user, courtId);
    await this.plans.requireFeature(court.venueId, 'peak_pricing');
    if (dto.weekdays.length === 0 || dto.weekdays.some((d) => d < 0 || d > 6)) {
      throw new BadRequestException('weekdays must be a non-empty list of 0 (Sun) – 6 (Sat)');
    }
    if (dto.endMinutes <= dto.startMinutes || dto.endMinutes > 1800) {
      throw new BadRequestException('Price window must end after it starts (overnight allowed, by 06:00)');
    }
    if (dto.pricePerHour < 0) {
      throw new BadRequestException('pricePerHour cannot be negative');
    }
    const startsOn = dto.startsOn ? parseDateOnly(dto.startsOn) : null;
    const endsOn = dto.endsOn ? parseDateOnly(dto.endsOn) : null;
    if (startsOn && endsOn && endsOn < startsOn) {
      throw new BadRequestException('endsOn must not be before startsOn');
    }
    const existing = await this.prisma.courtPriceWindow.findMany({
      where: { courtId },
    });
    const clash = existing.some((w) => {
      const sameDay = w.weekdays.some((d) => dto.weekdays.includes(d));
      const sameTime =
        dto.startMinutes < w.endMinutes && dto.endMinutes > w.startMinutes;
      const aStart = startsOn ? toYmd(startsOn) : '0000-01-01';
      const aEnd = endsOn ? toYmd(endsOn) : '9999-12-31';
      const bStart = w.startsOn ? toYmd(w.startsOn) : '0000-01-01';
      const bEnd = w.endsOn ? toYmd(w.endsOn) : '9999-12-31';
      const sameDates = aStart <= bEnd && bStart <= aEnd;
      return sameDay && sameTime && sameDates;
    });
    if (clash) {
      throw new BadRequestException(
        'Price windows cannot overlap — a slot can only have one special rate',
      );
    }
    return this.prisma.courtPriceWindow.create({
      data: {
        courtId,
        weekdays: dto.weekdays,
        startMinutes: dto.startMinutes,
        endMinutes: dto.endMinutes,
        pricePerHour: dto.pricePerHour,
        startsOn,
        endsOn,
      },
    });
  }

  async deletePriceWindow(user: AuthUser, windowId: string) {
    const win = await this.prisma.courtPriceWindow.findUnique({
      where: { id: windowId },
      include: { court: { select: { venueId: true } } },
    });
    if (!win) throw new NotFoundException('Price window not found');
    await this.assertVenue(user, win.court.venueId);
    await this.prisma.courtPriceWindow.delete({ where: { id: windowId } });
    return { ok: true };
  }

  /**
   * Replace a court's weekly-hours template. Conflict protection: future
   * pending/confirmed bookings that no longer fit inside a window are
   * reported; nothing is saved until the owner acknowledges them
   * (acknowledged bookings are kept as-is — grandfathered).
   */
  async setWeeklyHours(user: AuthUser, courtId: string, dto: SetWeeklyHoursDto) {
    const court = await this.assertCourt(user, courtId);
    // Split shifts (more than one window in a day) are a plan feature.
    if (dto.days.some((d) => d.windows.length > 1)) {
      await this.plans.requireFeature(court.venueId, 'advanced_availability');
    }
    for (const day of dto.days) {
      if (day.weekday < 0 || day.weekday > 6) {
        throw new BadRequestException('weekday must be 0 (Sun) – 6 (Sat)');
      }
      const sorted = [...day.windows].sort((a, b) => a.startMinutes - b.startMinutes);
      for (let i = 0; i < sorted.length; i++) {
        const w = sorted[i];
        // Windows start on their own day; the end may run past midnight
        // (overnight courts) up to 06:00 next day, max 20h per window.
        if (
          w.startMinutes < 0 ||
          w.startMinutes >= 1440 ||
          w.endMinutes <= w.startMinutes ||
          w.endMinutes > 1800 ||
          w.endMinutes - w.startMinutes > 1200
        ) {
          throw new BadRequestException(
            'Each window must start within its day, end after it starts, and run at most 20 hours (closing by 06:00 next day)',
          );
        }
        if (i > 0 && w.startMinutes < sorted[i - 1].endMinutes) {
          throw new BadRequestException('Windows on the same day cannot overlap');
        }
      }
    }
    // An overnight spill must not collide with the next day's first
    // window (the same physical hours can't be sold under two dates).
    for (const day of dto.days) {
      const spill = Math.max(0, ...day.windows.map((w) => w.endMinutes - 1440));
      if (spill <= 0) continue;
      const next = dto.days.find((d) => d.weekday === (day.weekday + 1) % 7);
      if (next && next.windows.some((w) => w.startMinutes < spill)) {
        throw new BadRequestException(
          'The next day has a window starting before this day\'s overnight closing ends',
        );
      }
    }

    const future = await this.prisma.booking.findMany({
      where: {
        courtId,
        date: { gte: startOfToday() },
        status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
      },
      include: { user: { select: { name: true } } },
      orderBy: [{ date: 'asc' }, { startMinutes: 'asc' }],
    });
    const conflicts = future
      .filter((b) => {
        const day = dto.days.find((d) => d.weekday === b.date.getDay());
        const windows = day?.windows ?? [];
        return !windows.some(
          (w) => b.startMinutes >= w.startMinutes && b.endMinutes <= w.endMinutes,
        );
      })
      .map((b) => this.conflictView(b));

    if (conflicts.length > 0 && !dto.acknowledgeConflicts) {
      return { saved: false, conflicts };
    }

    const flat = dto.days.flatMap((d) =>
      d.windows.map((w) => ({
        courtId,
        weekday: d.weekday,
        startMinutes: w.startMinutes,
        endMinutes: w.endMinutes,
      })),
    );
    await this.prisma.$transaction([
      this.prisma.courtWeeklyWindow.deleteMany({ where: { courtId } }),
      ...(flat.length > 0
        ? [this.prisma.courtWeeklyWindow.createMany({ data: flat })]
        : []),
    ]);
    // Keep the court's headline hours in sync (earliest open / latest
    // close across the week) for dashboards and occupancy math.
    if (flat.length > 0) {
      await this.prisma.court.update({
        where: { id: courtId },
        data: {
          openMinutes: Math.min(...flat.map((w) => w.startMinutes)),
          closeMinutes: Math.max(...flat.map((w) => w.endMinutes)),
        },
      });
    }
    return { saved: true, conflicts };
  }

  /**
   * Create a recurring block (e.g. daily break, Friday prayer break, a
   * Ramadan schedule with a date range). Conflicts are bookings in the
   * next 60 days (or the block's own range) that overlap it.
   */
  async createRecurringBlock(user: AuthUser, courtId: string, dto: CreateRecurringBlockDto) {
    const court = await this.assertCourt(user, courtId);
    await this.plans.requireFeature(court.venueId, 'advanced_availability');
    if (dto.weekdays.length === 0 || dto.weekdays.some((d) => d < 0 || d > 6)) {
      throw new BadRequestException('weekdays must be a non-empty list of 0 (Sun) – 6 (Sat)');
    }
    if (dto.endMinutes <= dto.startMinutes) {
      throw new BadRequestException('endMinutes must be after startMinutes');
    }
    if (dto.endMinutes > 1440) {
      throw new BadRequestException('Recurring breaks cannot cross midnight');
    }
    const startsOn = dto.startsOn ? parseDateOnly(dto.startsOn) : null;
    const endsOn = dto.endsOn ? parseDateOnly(dto.endsOn) : null;
    if (startsOn && endsOn && endsOn < startsOn) {
      throw new BadRequestException('endsOn must not be before startsOn');
    }

    const today = startOfToday();
    const from = startsOn && startsOn > today ? startsOn : today;
    const horizon = new Date(from);
    horizon.setDate(horizon.getDate() + 60);
    const to = endsOn && endsOn < horizon ? endsOn : horizon;

    const conflicts: ReturnType<typeof this.conflictView>[] = [];
    if (to >= from) {
      const rows = await this.prisma.booking.findMany({
        where: {
          courtId,
          date: { gte: from, lte: to },
          status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
        },
        include: { user: { select: { name: true } } },
        orderBy: [{ date: 'asc' }, { startMinutes: 'asc' }],
      });
      for (const b of rows) {
        if (!dto.weekdays.includes(b.date.getDay())) continue;
        if (b.startMinutes < dto.endMinutes && b.endMinutes > dto.startMinutes) {
          conflicts.push(this.conflictView(b));
        }
      }
    }
    if (conflicts.length > 0 && !dto.acknowledgeConflicts) {
      return { saved: false, conflicts };
    }
    const block = await this.prisma.recurringBlock.create({
      data: {
        courtId,
        weekdays: dto.weekdays,
        startMinutes: dto.startMinutes,
        endMinutes: dto.endMinutes,
        reason: dto.reason,
        startsOn,
        endsOn,
      },
    });
    return { saved: true, block, conflicts };
  }

  async deleteRecurringBlock(user: AuthUser, blockId: string) {
    const block = await this.prisma.recurringBlock.findUnique({
      where: { id: blockId },
      include: { court: { select: { venueId: true } } },
    });
    if (!block) throw new NotFoundException('Recurring block not found');
    await this.assertVenue(user, block.court.venueId);
    await this.prisma.recurringBlock.delete({ where: { id: blockId } });
    return { ok: true };
  }

  /**
   * Close one day: writes a full-day SlotBlock per open window for one
   * court — or for every court of the venue when courtId is omitted
   * (rain day / holiday). Returns the day's affected bookings so the UI
   * can offer to cancel them; nothing is cancelled automatically.
   */
  async createClosure(user: AuthUser, venueId: string, dto: CreateClosureDto) {
    await this.assertVenue(user, venueId);
    const date = parseDateOnly(dto.date);
    const courts = await this.prisma.court.findMany({
      where: {
        venueId,
        isActive: true,
        ...(dto.courtId ? { id: dto.courtId } : {}),
      },
    });
    if (dto.courtId && courts.length === 0) {
      throw new NotFoundException('Court not found');
    }
    let created = 0;
    const conflicts: (ReturnType<typeof this.conflictView> & { courtName: string })[] = [];
    for (const court of courts) {
      const windows = await this.courtsSvc.windowsForDate(court, date);
      for (const w of windows) {
        const existing = await this.prisma.slotBlock.findFirst({
          where: {
            courtId: court.id,
            date,
            startMinutes: w.startMinutes,
            endMinutes: w.endMinutes,
          },
          select: { id: true },
        });
        if (!existing) {
          await this.prisma.slotBlock.create({
            data: {
              courtId: court.id,
              date,
              startMinutes: w.startMinutes,
              endMinutes: w.endMinutes,
              reason: dto.reason ?? 'Closed',
            },
          });
          created++;
        }
      }
      const rows = await this.prisma.booking.findMany({
        where: {
          courtId: court.id,
          date,
          status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
        },
        include: { user: { select: { name: true } } },
        orderBy: { startMinutes: 'asc' },
      });
      for (const b of rows) {
        conflicts.push({ ...this.conflictView(b), courtName: court.name });
      }
    }
    return { created, conflicts };
  }

  // --------------------------------------------------------------- bookings
  async bookings(user: AuthUser, query: BookingsQueryDto) {
    const ids = query.venueId
      ? [(await this.assertVenue(user, query.venueId)).id]
      : await this.venueIds(user);
    const page = query.page ?? 1;
    const limit = pageLimit(query.limit, 50);
    const where: Prisma.BookingWhereInput = {
      venueId: { in: ids },
      ...(query.date ? { date: parseDateOnly(query.date) } : {}),
      ...(query.status ? { status: query.status as BookingStatus } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.booking.count({ where }),
      this.prisma.booking.findMany({
        where,
        include: {
          court: { select: { name: true, sport: true } },
          venue: { select: { name: true } },
          user: { select: { name: true, phone: true } },
          _count: { select: { participants: true } },
        },
        orderBy: [{ date: 'desc' }, { startMinutes: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return offsetPageFromDb(items, total, page, limit);
  }

  async acceptBooking(user: AuthUser, bookingId: string) {
    const booking = await this.ownedBooking(user, bookingId);
    await this.assertVenueActionable(booking.venueId);
    // Single-booking accept re-validates what the list view showed
    // when the owner opened it: the court must still be bookable
    // (live venue, approved court), and the slot must not have
    // started while the request sat pending.
    await this.courtsSvc.getActiveCourt(booking.courtId);
    const now = new Date();
    const started =
      booking.date < startOfToday() ||
      (isSameDay(booking.date, now) && booking.startMinutes <= minutesSinceMidnight(now));
    if (started) throw new BadRequestException('Cannot accept a slot that already started');
    return this.bookingOps.acceptBooking(bookingId);
  }

  async rejectBooking(user: AuthUser, bookingId: string, reason?: string) {
    await this.ownedBooking(user, bookingId);
    return this.bookingOps.rejectBooking(bookingId, reason);
  }

  async acceptSeries(user: AuthUser, recurrenceId: string, venueId: string) {
    await this.assertVenue(user, venueId);
    await this.assertVenueActionable(venueId);
    return this.bookingOps.acceptSeries(recurrenceId, venueId);
  }

  async cancelBooking(user: AuthUser, bookingId: string) {
    await this.ownedBooking(user, bookingId);
    return this.bookingOps.cancelByOwner(bookingId);
  }

  async walkIn(user: AuthUser, dto: WalkInDto) {
    const court = await this.prisma.court.findUnique({
      where: { id: dto.courtId },
      include: { venue: true },
    });
    if (!court) throw new NotFoundException('Court not found');
    await this.assertVenue(user, court.venueId);
    if (court.venue.status !== VenueStatus.approved) {
      throw new BadRequestException('Venue is not approved');
    }
    // Walk-ins are for guests physically present — never backdated.
    // skipWindowCheck below only waives the min-advance window, not
    // the past.
    const slotDate = parseDateOnly(dto.date);
    const now = new Date();
    const past =
      slotDate < startOfToday() ||
      (isSameDay(slotDate, now) && dto.startMinutes <= minutesSinceMidnight(now));
    if (past) {
      throw new BadRequestException('Walk-ins cannot be backdated — the slot has already started');
    }
    const booking = await this.bookingOps.create({
      courtId: dto.courtId,
      date: dto.date,
      startMinutes: dto.startMinutes,
      slotCount: dto.slotCount ?? 1,
      guestName: dto.guestName,
      skipWindowCheck: true, // the guest is physically at the venue
    });
    // Walk-ins skip approval — confirmed immediately, then marked checked-in.
    await this.prisma.booking.update({
      where: { id: booking.id },
      data: { status: BookingStatus.confirmed, checkedInAt: new Date() },
    });
    return this.prisma.booking.findUnique({ where: { id: booking.id } });
  }

  async checkInScan(user: AuthUser, venueId: string, code: string) {
    await this.assertVenue(user, venueId);
    return this.bookingOps.checkInByCode(code.toUpperCase().trim(), venueId);
  }

  async checkIn(user: AuthUser, bookingId: string) {
    await this.ownedBooking(user, bookingId);
    return this.bookingOps.checkIn(bookingId);
  }

  async markNoShow(user: AuthUser, bookingId: string) {
    await this.ownedBooking(user, bookingId);
    return this.bookingOps.markNoShow(bookingId);
  }

  // ------------------------------------------------------------- reschedules
  async reschedules(user: AuthUser, status = 'pending', cursor?: string, rawLimit?: number) {
    const limit = pageLimit(rawLimit, 30);
    const ids = await this.venueIds(user);
    const rows = await this.prisma.rescheduleRequest.findMany({
      where: {
        booking: { venueId: { in: ids } },
        status,
        ...keysetWhere(cursor, 'createdAt', 'desc'),
      },
      include: {
        booking: {
          include: {
            court: { select: { name: true } },
            user: { select: { name: true, phone: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return {
      items: rows.slice(0, limit),
      nextCursor:
        rows.length > limit
          ? encodeCursor(rows[limit - 1].createdAt, rows[limit - 1].id)
          : null,
    };
  }

  /**
   * Re-validates a pending reschedule request at accept time. The world
   * may have changed since the player asked: the booking may have left
   * the confirmed state, the venue may have been sanctioned / paused /
   * archived, the court deactivated, the slot may have passed, or the
   * promo may have died. Anything that fails here means the request
   * can no longer be honoured (the caller auto-rejects it).
   */
  private async validateRescheduleAccept(
    req: Prisma.RescheduleRequestGetPayload<{ include: { booking: true } }>,
  ) {
    // A booking that already left the confirmed state must never be
    // resurrected by a stale pending request.
    if (req.booking.status !== BookingStatus.confirmed) {
      throw new BadRequestException('Only confirmed bookings can be rescheduled');
    }
    // The ORIGINAL slot is re-checked too: a booking that already
    // started (or was checked in) must not be moved — moving it would
    // rewrite a game already in play. Like every other failure here,
    // this auto-rejects the request.
    const now = new Date();
    const origStarted =
      req.booking.date < startOfToday() ||
      (isSameDay(req.booking.date, now) &&
        req.booking.startMinutes <= minutesSinceMidnight(now));
    if (origStarted || req.booking.checkedInAt) {
      throw new BadRequestException('The original slot has already started and cannot be moved');
    }
    // Re-run the booking choke point + venue-actionable gates.
    const court = await this.courtsSvc.getActiveCourt(req.booking.courtId);
    await this.assertVenueActionable(req.booking.venueId);
    const startMinutes = req.requestedStartMinutes;
    const endMinutes = req.requestedEndMinutes;
    // The requested slot may have passed since the request was made.
    const slotAt = new Date(req.requestedDate);
    slotAt.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
    if (slotAt <= new Date()) {
      throw new BadRequestException('Requested slot is no longer in the future');
    }
    // Alignment + the requested day's open windows (weekly template
    // or the court's default hours).
    const reqWindows = await this.courtsSvc.windowsForDate(court, req.requestedDate);
    const reqWindow = reqWindows.find(
      (w) => startMinutes >= w.startMinutes && endMinutes <= w.endMinutes,
    );
    if (!reqWindow || (startMinutes - reqWindow.startMinutes) % court.slotMinutes !== 0) {
      throw new BadRequestException('Requested slot is outside court hours');
    }
    const reqBlocked = await this.courtsSvc.blockedRangesForDate(
      req.booking.courtId,
      req.requestedDate,
    );
    if (
      reqBlocked.some((r) => startMinutes < r.endMinutes && endMinutes > r.startMinutes)
    ) {
      throw new ConflictException('Requested slot is blocked by the arena');
    }
    // Conflict re-check (excluding the booking being moved).
    const clash = await this.prisma.booking.findFirst({
      where: {
        id: { not: req.bookingId },
        courtId: req.booking.courtId,
        date: req.requestedDate,
        status: { in: [BookingStatus.pending, BookingStatus.confirmed] },
        startMinutes: { lt: endMinutes },
        endMinutes: { gt: startMinutes },
      },
    });
    if (clash) throw new ConflictException('Requested slot is no longer available');
    // Re-validate any promo the booking carries (expiry, venue scope,
    // per-user limit). The per-user count excludes this booking's own
    // redemption — otherwise a perUserLimit of 1 would always fail its
    // own booking. The promo row itself is returned so the accept path
    // can RECOMPUTE the discount from its kind against the new gross
    // — carrying the old flat amount forward silently re-priced
    // percent promos as flat ones.
    let promo: PromoCode | null = null;
    if (req.booking.promoCodeId) {
      promo = await this.prisma.promoCode.findUnique({
        where: { id: req.booking.promoCodeId },
      });
      if (!promo || !promo.isActive) {
        throw new BadRequestException('The promo on this booking is no longer active');
      }
      if (promo.venueId && promo.venueId !== req.booking.venueId) {
        throw new BadRequestException('This promo code is not valid for this venue');
      }
      const now = new Date();
      if (promo.validFrom > now || promo.validTo < now) {
        throw new BadRequestException('Promo code is expired');
      }
      if (req.booking.userId) {
        const otherUses = await this.prisma.promoRedemption.count({
          where: {
            promoCodeId: promo.id,
            userId: req.booking.userId,
            bookingId: { not: req.bookingId },
          },
        });
        if (otherUses >= promo.perUserLimit) {
          throw new BadRequestException('Promo code already used');
        }
      }
    }
    return { court, startMinutes, endMinutes, promo };
  }

  async acceptReschedule(user: AuthUser, requestId: string) {
    const req = await this.prisma.rescheduleRequest.findUnique({
      where: { id: requestId },
      include: { booking: true },
    });
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'pending') throw new BadRequestException('Request already decided');
    const venue = await this.assertVenue(user, req.booking.venueId);

    // Any accept-time validation failure auto-rejects the request with
    // the reason, instead of leaving it pending forever (which would
    // block the player from requesting again). The update is guarded to
    // pending so a concurrent decision is never overwritten.
    let validated: {
      court: Awaited<ReturnType<CourtsService['getActiveCourt']>>;
      startMinutes: number;
      endMinutes: number;
      promo: PromoCode | null;
    };
    try {
      validated = await this.validateRescheduleAccept(req);
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof ConflictException ||
        err instanceof NotFoundException ||
        err instanceof ForbiddenException
      ) {
        await this.prisma.rescheduleRequest.updateMany({
          where: { id: requestId, status: 'pending' },
          data: { status: 'rejected', reason: err.message, decidedAt: new Date() },
        });
        // An auto-reject is still a decision the player must hear
        // about — otherwise they keep waiting on a dead request.
        if (req.booking.userId) {
          await this.notifications
            .pushToUser(req.booking.userId, {
              title: 'Reschedule declined',
              body: `Your reschedule request at ${venue.name} could not be honoured: ${err.message}`,
              data: { type: 'reschedule_decision' },
            })
            .catch(() => {});
        }
      }
      throw err;
    }
    const { court, startMinutes, endMinutes } = validated;

    // Re-price at the new slot with the same per-slot engine as booking
    // creation (peak/off-peak windows on the requested date). Without
    // this the moved booking kept its old price — an off-peak booking
    // could move into peak hours, or a longer duration, for free.
    const priceWindows = await this.courtsSvc.priceWindowsForDate(
      court.id,
      req.requestedDate,
    );
    const baseRate = Number(court.pricePerHour);
    let gross = 0;
    for (let s = startMinutes; s < endMinutes; s += court.slotMinutes) {
      gross +=
        this.courtsSvc.priceRateForSlot(priceWindows, baseRate, s) *
        (court.slotMinutes / 60);
    }
    // Same 2dp rounding as booking creation — fractional paisa must
    // never reach a stored total.
    gross = Math.round(gross * 100) / 100;
    // Recompute the discount from the promo KIND against the new gross
    // (percent × new gross, capped by maxDiscount; flat at most its
    // value, also capped by maxDiscount), then cap at the new gross so
    // the total can never go negative.
    let discount = 0;
    const promo = validated.promo;
    if (promo) {
      if (promo.kind === 'percent') {
        discount = (gross * Number(promo.value)) / 100;
      } else {
        discount = Number(promo.value);
      }
      if (promo.maxDiscount != null) {
        discount = Math.min(discount, Number(promo.maxDiscount));
      }
      discount = Math.round(discount * 100) / 100;
    }
    discount = Math.min(discount, gross);
    const newTotal = Math.max(0, gross - discount);

    const [booking] = await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: req.bookingId },
        data: {
          date: req.requestedDate,
          startMinutes,
          endMinutes,
          totalPrice: newTotal,
          discountAmount: discount,
          // A moved booking has not been played at the new slot yet.
          checkedInAt: null,
          status: BookingStatus.confirmed,
        },
      }),
      this.prisma.rescheduleRequest.update({
        where: { id: requestId },
        data: { status: 'approved', decidedAt: new Date() },
      }),
    ]);
    // The old slot just freed up — ping its waitlist (whole old range).
    for (
      let s = req.booking.startMinutes;
      s < req.booking.endMinutes;
      s += court.slotMinutes
    ) {
      const freed = await this.prisma.slotWaitlist.findMany({
        where: {
          courtId: req.booking.courtId,
          date: req.booking.date,
          startMinutes: s,
          notifiedAt: null,
        },
      });
      for (const w of freed) {
        await this.notifications
          .pushToUser(w.userId, {
            title: 'A slot just opened up',
            body: `A slot you were waiting on is free again on ${req.booking.date.toISOString().slice(0, 10)} — first come, first served.`,
            data: { type: 'slot_opened' },
          })
          .catch(() => {});
      }
      if (freed.length > 0) {
        await this.prisma.slotWaitlist.updateMany({
          where: { id: { in: freed.map((w) => w.id) } },
          data: { notifiedAt: new Date() },
        });
      }
    }
    // A linked game post follows its booking to the new time, and the
    // squad hears about the move.
    const post = await this.prisma.gamePost.findUnique({
      where: { bookingId: req.bookingId },
    });
    if (post) {
      await this.prisma.gamePost.update({
        where: { id: post.id },
        data: { date: req.requestedDate, startMinutes },
      });
      const squad = await this.prisma.gameParticipant.findMany({
        where: { postId: post.id, userId: { not: null } },
        select: { userId: true },
      });
      const hh = String(Math.floor(startMinutes / 60)).padStart(2, '0');
      const mm = String(startMinutes % 60).padStart(2, '0');
      for (const s of squad) {
        await this.notifications
          .pushToUser(s.userId!, {
            title: 'Game time moved',
            body: `Your ${post.sport} game moved to ${req.requestedDate.toISOString().slice(0, 10)} at ${hh}:${mm}.`,
            data: { type: 'game_rescheduled' },
          })
          .catch(() => {});
      }
    }
    // The requesting player hears the decision itself, not just the
    // squad chatter — accept and reject were both silent before.
    if (req.booking.userId) {
      await this.notifications
        .notifyRescheduleDecision(req.booking.userId, true, venue.name)
        .catch(() => {});
    }
    return booking;
  }

  async rejectReschedule(user: AuthUser, requestId: string, reason?: string) {
    const req = await this.prisma.rescheduleRequest.findUnique({
      where: { id: requestId },
      include: { booking: true },
    });
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'pending') throw new BadRequestException('Request already decided');
    const venue = await this.assertVenue(user, req.booking.venueId);
    const rejected = await this.prisma.rescheduleRequest.update({
      where: { id: requestId },
      data: { status: 'rejected', reason, decidedAt: new Date() },
    });
    if (req.booking.userId) {
      await this.notifications
        .notifyRescheduleDecision(req.booking.userId, false, venue.name)
        .catch(() => {});
    }
    return rejected;
  }

  // ------------------------------------------------------------------ staff
  /** Roles the super admin enabled for this venue — the only ones the owner may hand out. */
  async allowedRoles(user: AuthUser, venueId: string) {
    const venue = await this.assertVenue(user, venueId);
    // Only live, in-scope links: a disabled role must not be handed
    // out again (it would silently gain its permissions on re-enable),
    // and a link to another owner's role (legacy data) is never valid.
    const links = await this.prisma.venueAllowedRole.findMany({
      where: {
        venueId,
        role: {
          isActive: true,
          OR: [{ ownerId: null }, { ownerId: venue.ownerId }],
        },
      },
      include: { role: true },
    });
    const roles = links.map((l) => l.role);
    // The owner's own roles are assignable at all of his venues.
    if (venue.ownerId === user.id || user.permissions.includes('venues.manage')) {
      const own = await this.prisma.role.findMany({
        where: { ownerId: venue.ownerId, scope: 'arena', isActive: true },
        orderBy: { name: 'asc' },
      });
      const seen = new Set(roles.map((r) => r.id));
      for (const r of own) if (!seen.has(r.id)) roles.push(r);
    }
    return roles;
  }

  async staffList(user: AuthUser, venueId: string) {
    await this.assertVenue(user, venueId);
    return this.prisma.venueStaff.findMany({
      where: { venueId },
      include: { user: { select: { id: true, name: true, email: true, role: { select: { name: true } } } } },
    });
  }

  // ------------------------------------------------------------ own roles
  /** Roles this owner can assign: platform arena roles the super admin
   * enabled for his venues, plus roles he created himself. */
  async listMyRoles(user: AuthUser) {
    const venues = await this.prisma.venue.findMany({
      where: { ownerId: user.id },
      select: { id: true },
    });
    const allowed = await this.prisma.venueAllowedRole.findMany({
      where: { venueId: { in: venues.map((v) => v.id) } },
      include: {
        role: { include: { _count: { select: { users: true } } } },
      },
    });
    const systemById = new Map<string, (typeof allowed)[number]['role']>();
    for (const row of allowed) {
      if (row.role.ownerId === null && row.role.scope === 'arena') {
        systemById.set(row.role.id, row.role);
      }
    }
    const own = await this.prisma.role.findMany({
      where: { ownerId: user.id },
      include: { _count: { select: { users: true } } },
      orderBy: { name: 'asc' },
    });
    return {
      system: [...systemById.values()].sort((x, y) => x.name.localeCompare(y.name)),
      own,
      grantablePermissions: [...ARENA_ROLE_PERMISSIONS],
    };
  }

  private assertGrantable(permissions: string[]) {
    const bad = permissions.filter(
      (p) => !(ARENA_ROLE_PERMISSIONS as readonly string[]).includes(p),
    );
    if (bad.length > 0) {
      throw new BadRequestException(
        `These permissions can't be granted by an owner: ${bad.join(', ')}`,
      );
    }
  }

  /**
   * The owner a role minted through this account belongs to. Owners own
   * their own roles; a staff caller mints roles for the single venue
   * owner they serve (serving several owners is ambiguous → rejected).
   * The old code always used the caller's id, which let a staff member
   * mint a fully-permissioned role owned by themselves and invisible
   * to the real owner.
   */
  private async resolveRoleOwnerId(user: AuthUser): Promise<string> {
    // Ownership is a fact about venues, never a role NAME: a staffer
    // whose role happens to be called 'owner' is not an owner, and a
    // super admin ('*') owns no venues at all. A user who owns ≥1
    // venue resolves to themselves; anyone else resolves to the single
    // owner they serve as staff.
    const owned = await this.prisma.venue.findMany({
      where: { ownerId: user.id },
      select: { id: true },
    });
    if (owned.length > 0) return user.id;
    const links = await this.prisma.venueStaff.findMany({
      where: { userId: user.id },
      select: { venueId: true },
    });
    if (links.length === 0) {
      throw new ForbiddenException('Only venue owners can manage roles');
    }
    const venues = await this.prisma.venue.findMany({
      where: { id: { in: links.map((l) => l.venueId) } },
      select: { ownerId: true },
    });
    const owners = [...new Set(venues.map((v) => v.ownerId))];
    if (owners.length !== 1) {
      throw new BadRequestException(
        'You serve venues of more than one owner — ask an owner to create this role',
      );
    }
    return owners[0];
  }

  /**
   * A non-owner may only grant permissions they hold themselves —
   * otherwise a manager holding only staff.manage could mint a role
   * with full arena control and log into it. Owners (by actual venue
   * ownership, not role name) and '*' pass.
   */
  private assertCallerMayGrant(user: AuthUser, permissions: string[], isOwner: boolean) {
    if (user.permissions.includes('*') || isOwner) return;
    const missing = permissions.filter((p) => !user.permissions.includes(p));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `You cannot grant permission(s) you do not hold: ${missing.join(', ')}`,
      );
    }
  }

  async createMyRole(user: AuthUser, dto: CreateMyRoleDto) {
    this.assertGrantable(dto.permissions);
    const ownerId = await this.resolveRoleOwnerId(user);
    this.assertCallerMayGrant(user, dto.permissions, ownerId === user.id);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Role name is required');
    const clash = await this.prisma.role.findFirst({
      where: { ownerId, name: { equals: name, mode: 'insensitive' } },
    });
    if (clash) throw new ConflictException('You already have a role with this name');
    // Platform role names are reserved: @@unique([ownerId, name]) does
    // not protect them (NULL ownerIds are distinct in Postgres), and
    // name-based lookups (owner role, last-admin guards) would start
    // matching this owner's role instead of the platform's.
    const systemClash = await this.prisma.role.findFirst({
      where: { ownerId: null, name: { equals: name, mode: 'insensitive' } },
    });
    if (systemClash) throw new ConflictException('That name belongs to a platform role');
    const created = await this.prisma.role.create({
      data: {
        name,
        description: dto.description,
        permissions: [...new Set(dto.permissions)],
        scope: 'arena',
        ownerId,
      },
    });
    // Audit only, never a block: recreating a DISABLED role's exact
    // permission set is usually "un-delete by re-creation" — but it
    // can also silently resurrect a set the owner deliberately turned
    // off, so it leaves a trail.
    const newPerms = [...new Set(dto.permissions)].sort().join(',');
    const disabled = await this.prisma.role.findMany({
      where: { ownerId, isActive: false, id: { not: created.id } },
      select: { id: true, name: true, permissions: true },
    });
    const duplicate = disabled.find(
      (r) => [...new Set(r.permissions)].sort().join(',') === newPerms,
    );
    if (duplicate) {
      await this.prisma.auditLog.create({
        data: {
          actorId: user.id,
          action: 'role.create.duplicates_disabled',
          entity: 'role',
          entityId: created.id,
          details: `duplicates disabled role "${duplicate.name}" (${duplicate.id})`,
        },
      });
    }
    return created;
  }

  async updateMyRole(user: AuthUser, roleId: string, dto: UpdateMyRoleDto) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');
    const ownerId = await this.resolveRoleOwnerId(user);
    if (role.ownerId !== ownerId) throw new NotFoundException('Role not found');
    // Only a permission change is a grant: a name/description edit by
    // staff must not fail on keys the role already holds.
    if (dto.permissions) {
      this.assertGrantable(dto.permissions);
      this.assertCallerMayGrant(user, dto.permissions, ownerId === user.id);
    }
    if (dto.name && dto.name.trim().toLowerCase() !== role.name.toLowerCase()) {
      const clash = await this.prisma.role.findFirst({
        where: {
          ownerId,
          name: { equals: dto.name.trim(), mode: 'insensitive' },
          id: { not: roleId },
        },
      });
      if (clash) throw new ConflictException('You already have a role with this name');
      const systemClash = await this.prisma.role.findFirst({
        where: { ownerId: null, name: { equals: dto.name.trim(), mode: 'insensitive' } },
      });
      if (systemClash) throw new ConflictException('That name belongs to a platform role');
    }
    return this.prisma.role.update({
      where: { id: roleId },
      data: {
        name: dto.name?.trim() ?? undefined,
        description: dto.description,
        permissions: dto.permissions ? [...new Set(dto.permissions)] : undefined,
      },
    });
  }

  async deleteMyRole(user: AuthUser, roleId: string) {
    // Same ownership resolution as updateMyRole: a single-owner staffer
    // who may edit a role may also delete it. System roles (ownerId
    // null) can never match a resolved owner id, and the in-use guard
    // below still applies.
    const ownerId = await this.resolveRoleOwnerId(user);
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, ownerId },
      include: { _count: { select: { users: true } } },
    });
    if (!role) throw new NotFoundException('Role not found');
    if (role._count.users > 0) {
      throw new BadRequestException(
        `${role._count.users} team member(s) still hold this role — reassign them first`,
      );
    }
    await this.prisma.role.delete({ where: { id: roleId } });
    return { deleted: true };
  }

  // ------------------------------------------------------------ own promos
  /** Promos this owner manages (venue-scoped), across all his venues. */
  async listMyPromos(user: AuthUser) {
    return this.prisma.promoCode.findMany({
      where: { venue: { ownerId: user.id } },
      include: { venue: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createMyPromo(user: AuthUser, dto: CreateMyPromoDto) {
    await this.assertVenue(user, dto.venueId);
    const code = dto.code.toUpperCase().trim();
    if (!code) throw new BadRequestException('Promo code is required');
    if (dto.kind === 'percent' && (dto.value < 1 || dto.value > 100)) {
      throw new BadRequestException('Percent promo value must be between 1 and 100');
    }
    if (dto.kind === 'flat' && dto.value < 1) {
      throw new BadRequestException('Flat promo value must be at least Rs 1');
    }
    const exists = await this.prisma.promoCode.findUnique({ where: { code } });
    if (exists) throw new ConflictException('This code is already in use');
    const validTo = new Date(dto.validTo);
    if (isNaN(validTo.getTime()) || validTo <= new Date()) {
      throw new BadRequestException('validTo must be a future date');
    }
    const validFrom = dto.validFrom ? new Date(dto.validFrom) : undefined;
    if (validFrom && isNaN(validFrom.getTime())) {
      throw new BadRequestException('validFrom must be a valid date');
    }
    if (validFrom && validFrom >= validTo) {
      throw new BadRequestException('validFrom must be before validTo');
    }
    return this.prisma.promoCode.create({
      data: {
        venueId: dto.venueId,
        createdById: user.id,
        code,
        kind: dto.kind,
        value: dto.value,
        maxDiscount: dto.maxDiscount,
        maxUses: dto.maxUses,
        perUserLimit: dto.perUserLimit ?? 1,
        validFrom,
        validTo,
      },
      include: { venue: { select: { id: true, name: true } } },
    });
  }

  private async assertMyPromo(user: AuthUser, promoId: string) {
    const promo = await this.prisma.promoCode.findFirst({
      where: { id: promoId, venue: { ownerId: user.id } },
    });
    if (!promo) throw new NotFoundException('Promo not found');
    return promo;
  }

  async updateMyPromo(user: AuthUser, promoId: string, dto: UpdateMyPromoDto) {
    const existing = await this.assertMyPromo(user, promoId);
    // A redeemed promo's terms are frozen: rewriting value, limits, or
    // dates after redemptions would silently re-price every future
    // booking and leave no audit trail. Only activation may change.
    const termsChange =
      dto.value !== undefined ||
      dto.maxDiscount !== undefined ||
      dto.maxUses !== undefined ||
      dto.perUserLimit !== undefined ||
      dto.validFrom !== undefined ||
      dto.validTo !== undefined;
    if (termsChange && existing.usedCount > 0) {
      throw new BadRequestException(
        'This promo has already been redeemed — only activation can be changed now',
      );
    }
    if (dto.maxUses !== undefined && dto.maxUses < existing.usedCount) {
      throw new BadRequestException(
        `maxUses cannot go below the ${existing.usedCount} redemption(s) already recorded`,
      );
    }
    // Mirror the create-path validation (the old update had only
    // @Min(0), so a 150% promo stored a negative booking price).
    if (dto.value !== undefined && existing.kind === 'percent' && (dto.value < 1 || dto.value > 100)) {
      throw new BadRequestException('Percent promo value must be between 1 and 100');
    }
    if (dto.value !== undefined && existing.kind === 'flat' && dto.value < 1) {
      throw new BadRequestException('Flat promo value must be at least Rs 1');
    }
    const validFrom = dto.validFrom ? new Date(dto.validFrom) : undefined;
    const validTo = dto.validTo ? new Date(dto.validTo) : undefined;
    if (validFrom && isNaN(validFrom.getTime())) {
      throw new BadRequestException('validFrom must be a valid date');
    }
    if (validTo && isNaN(validTo.getTime())) {
      throw new BadRequestException('validTo must be a valid date');
    }
    if (validTo && validTo <= new Date()) {
      throw new BadRequestException('validTo must be a future date');
    }
    if ((validFrom ?? existing.validFrom) >= (validTo ?? existing.validTo)) {
      throw new BadRequestException('validFrom must be before validTo');
    }
    return this.prisma.promoCode.update({
      where: { id: promoId },
      data: {
        isActive: dto.isActive,
        value: dto.value,
        maxDiscount: dto.maxDiscount,
        maxUses: dto.maxUses,
        perUserLimit: dto.perUserLimit,
        validFrom,
        validTo,
      },
      include: { venue: { select: { id: true, name: true } } },
    });
  }

  async deleteMyPromo(user: AuthUser, promoId: string) {
    const promo = await this.assertMyPromo(user, promoId);
    if (promo.usedCount > 0) {
      throw new BadRequestException(
        'This promo has been used — deactivate it instead of deleting',
      );
    }
    await this.prisma.promoCode.delete({ where: { id: promoId } });
    return { deleted: true };
  }

  /** Throws when the arena is at its seat cap. Runs inside the caller's transaction. */
  private async assertSeatAvailable(
    tx: Prisma.TransactionClient,
    venueId: string,
    staffCap: { limit: number | null; source: 'override' | 'plan' },
  ) {
    if (staffCap.limit === null) return;
    const seats = await tx.venueStaff.count({ where: { venueId } });
    if (seats >= staffCap.limit) {
      throw new ForbiddenException(
        staffCap.source === 'override'
          ? `This arena's team seat limit is ${staffCap.limit}. Ask Areana about raising it.`
          : `Your plan allows ${staffCap.limit} staff seat(s) per venue. Ask Areana about upgrading.`,
      );
    }
  }

  async createStaff(user: AuthUser, venueId: string, dto: CreateStaffDto) {
    const venue = await this.assertVenue(user, venueId);
    const staffCap = await this.plans.effectiveStaffLimit(venueId);
    // An explicit admin override IS the grant — it can seat a team even
    // on a plan without the staff_accounts feature. Plan-based seating
    // still requires the feature.
    if (staffCap.source === 'plan') {
      await this.plans.requireFeature(venueId, 'staff_accounts');
    }
    // The seat check itself runs inside the write transaction below,
    // under the venue row lock — see assertSeatAvailable.
    // The role must be one the super admin allowed for this arena — or a
    // role this owner created for their own team. A disabled role is
    // never assignable (it would silently gain its permissions the
    // moment an admin re-enables it), and neither is another owner's
    // role (legacy links must not leak across owners).
    const allowed = await this.prisma.venueAllowedRole.findUnique({
      where: { venueId_roleId: { venueId, roleId: dto.roleId } },
      include: { role: true },
    });
    let staffRole = allowed?.role ?? null;
    if (staffRole) {
      if (!staffRole.isActive) {
        throw new ForbiddenException('This role is disabled and cannot be assigned');
      }
      if (staffRole.ownerId !== null && staffRole.ownerId !== venue.ownerId) {
        throw new ForbiddenException('This role belongs to another owner');
      }
    }
    if (!staffRole) {
      staffRole = await this.prisma.role.findFirst({
        where: { id: dto.roleId, ownerId: user.id, scope: 'arena', isActive: true },
      });
    }
    if (!staffRole) throw new ForbiddenException('This role is not enabled for your arena');
    if (staffRole.scope !== 'arena' || staffRole.name === 'owner') {
      throw new ForbiddenException('Cannot assign this role to team members');
    }
    const email = dto.email.toLowerCase().trim();
    const exists = await this.prisma.user.findUnique({
      where: { email },
      include: { role: true },
    });
    if (exists) {
      // Re-hiring someone who was removed: their account was suspended
      // when the last venue link went away — revive it in place rather
      // than dead-ending on 'email already registered'. Revival is
      // ONLY for ex-staff: a suspended OWNER or PLAYER must never be
      // revived through this path — an admin suspension is not an
      // owner decision to undo, and the old check (any suspended
      // arena-scope account with no links) reactivated suspended
      // owners outright. A platform role (owner/player) or any venues
      // owned therefore blocks revival.
      const ownedCount = await this.prisma.venue.count({
        where: { ownerId: exists.id },
      });
      const linkCount = await this.prisma.venueStaff.count({
        where: { userId: exists.id },
      });
      if (
        exists.status === 'suspended' &&
        exists.role.scope === 'arena' &&
        exists.role.name !== 'owner' &&
        exists.role.name !== 'player' &&
        ownedCount === 0 &&
        linkCount === 0
      ) {
        const passwordHash = await bcrypt.hash(dto.password, 10);
        const revived = await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR UPDATE`;
          await this.assertSeatAvailable(tx, venueId, staffCap);
          const u = await tx.user.update({
            where: { id: exists.id },
            data: {
              name: dto.name,
              passwordHash,
              roleId: dto.roleId,
              status: 'active',
            },
          });
          await tx.venueStaff.create({
            data: { venueId, userId: u.id },
          });
          return u;
        });
        const { passwordHash: _p, ...safe } = revived;
        return safe;
      }
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const member = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR UPDATE`;
      await this.assertSeatAvailable(tx, venueId, staffCap);
      const m = await tx.user.create({
        data: {
          email,
          name: dto.name,
          passwordHash,
          roleId: dto.roleId,
        },
      });
      await tx.venueStaff.create({ data: { venueId, userId: m.id } });
      return m;
    });
    const { passwordHash: _p, ...safe } = member;
    return safe;
  }

  /**
   * Owner-initiated password reset for a staff member at the owner's
   * own venues. The caller must be the venue owner (not a staff
   * member with staff.manage), the target must be arena-scoped staff
   * linked to one of the caller's venues, and the target's sessions
   * are revoked — exactly like changePassword. Audited.
   */
  async resetStaffPassword(user: AuthUser, staffId: string, newPassword: string) {
    // Owner by actual venue ownership, never by role name: a staffer
    // whose role happens to be called 'owner' is not an owner. (The
    // link check below enforces the same fact per-venue; this gate
    // fails fast with the right error.)
    const owned = await this.prisma.venue.count({ where: { ownerId: user.id } });
    if (owned === 0) {
      throw new ForbiddenException('Only the venue owner can reset a team member password');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: staffId },
      include: { role: { select: { scope: true, name: true } } },
    });
    if (!target) throw new NotFoundException('Team member not found');
    if (target.role.scope !== 'arena') {
      throw new ForbiddenException('Only arena team members can be reset from here');
    }
    const link = await this.prisma.venueStaff.findFirst({
      where: { userId: staffId, venue: { ownerId: user.id } },
      select: { id: true },
    });
    if (!link) {
      throw new ForbiddenException('This team member does not work at any of your venues');
    }
    await this.prisma.user.update({
      where: { id: staffId },
      data: { passwordHash: await bcrypt.hash(newPassword, 10) },
    });
    await this.prisma.refreshSession.updateMany({
      where: { userId: staffId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'staff.password_reset',
        entity: 'user',
        entityId: staffId,
      },
    });
    return { id: staffId, ok: true };
  }

  async removeStaff(user: AuthUser, staffLinkId: string) {
    const link = await this.prisma.venueStaff.findUnique({ where: { id: staffLinkId } });
    if (!link) throw new NotFoundException('Team member not found');
    await this.assertVenue(user, link.venueId);
    const deleted = await this.prisma.venueStaff.delete({ where: { id: staffLinkId } });
    // Last venue removed = the account must not keep a live login to an
    // empty panel. Suspend arena-scoped staff with no links left (and
    // kill their sessions); re-adding them later revives the account.
    const remaining = await this.prisma.venueStaff.count({
      where: { userId: link.userId },
    });
    if (remaining === 0) {
      const member = await this.prisma.user.findUnique({
        where: { id: link.userId },
        include: { role: { select: { scope: true } } },
      });
      if (member?.role.scope === 'arena') {
        await this.prisma.user.update({
          where: { id: link.userId },
          data: { status: 'suspended' },
        });
        await this.prisma.refreshSession.deleteMany({
          where: { userId: link.userId },
        });
        // A suspension the member never hears about looks like a
        // broken login — push and audit it like any other suspension.
        await this.notifications
          .pushToUser(link.userId, {
            title: 'Team access removed',
            body: 'You were removed from your last arena team, so your account is suspended. An arena owner can re-add you at any time.',
            data: { type: 'staff_removed' },
          })
          .catch(() => {});
        await this.prisma.auditLog.create({
          data: {
            actorId: user.id,
            action: 'staff.suspended',
            entity: 'user',
            entityId: link.userId,
            details: 'Last venue link removed — account suspended',
          },
        });
      }
    }
    return deleted;
  }

  // --------------------------------------------------------------- customers
  async customers(user: AuthUser, venueId?: string, page = 1, rawLimit?: number) {
    const allIds = venueId ? [(await this.assertVenue(user, venueId)).id] : await this.venueIds(user);
    const featureSets = await Promise.all(allIds.map((id) => this.plans.featuresForVenue(id)));
    if (!featureSets.some((f) => f.includes('customers_insight'))) {
      throw new ForbiddenException(
        "Your current plan doesn't include Customers & player history. Ask Areana about upgrading your plan.",
      );
    }
    // Without a venue filter the gate used to pass on ANY venue having
    // the feature, then return customers from ALL venues — including
    // ones whose plan never bought the insight. Restrict to the venues
    // that actually have the feature.
    const ids = venueId
      ? allIds
      : allIds.filter((_, i) => featureSets[i].includes('customers_insight'));
    const bookings = await this.prisma.booking.findMany({
      where: { venueId: { in: ids }, userId: { not: null } },
      select: {
        userId: true,
        date: true,
        status: true,
        user: { select: { name: true, phone: true, email: true, noShowCount: true } },
      },
    });
    const map = new Map<string, any>();
    for (const b of bookings) {
      const u = b.user!;
      if (!map.has(b.userId!)) {
        map.set(b.userId!, {
          userId: b.userId,
          name: u.name,
          phone: u.phone,
          email: u.email,
          visits: 0,
          noShows: 0,
          lastVisit: null as string | null,
        });
      }
      const c = map.get(b.userId!);
      if (b.status !== BookingStatus.cancelled) {
        c.visits += 1;
        const ds = b.date.toISOString().slice(0, 10);
        if (!c.lastVisit || ds > c.lastVisit) c.lastVisit = ds;
      }
      if (b.status === BookingStatus.no_show) c.noShows += 1;
    }
    const all = [...map.values()].sort((a, b) => b.visits - a.visits);
    return offsetPage(all, page, pageLimit(rawLimit, 50));
  }

  // ---------------------------------------------------------------- reviews
  /** Plan + billing state for every venue the user operates. */
  async billing(user: AuthUser) {
    // Billing is money: only owned venues, plus linked venues when the
    // caller holds billing.view. A staffer with no money-visible venue
    // gets a clean denial instead of an empty page that looks broken.
    const ids = await this.moneyVenueIds(user);
    if (ids.length === 0) {
      throw new ForbiddenException(
        'Billing is only visible to venue owners and team members with billing access',
      );
    }
    const venues = await this.prisma.venue.findMany({
      where: { id: { in: ids } },
      include: { plan: true },
      orderBy: { createdAt: 'asc' },
    });
    const out = [];
    for (const v of venues) {
      const billing = await this.plans.billingSummary(v);
      const plan = await this.plans.planForVenueId(v.id);
      out.push({
        venue: { id: v.id, name: v.name, city: v.city, status: v.status },
        planName: billing.planName,
        billing,
        features: await this.plans.featuresForVenue(v.id),
        seatsUsed: await this.prisma.venueStaff.count({ where: { venueId: v.id } }),
        seatsAllowed: (await this.plans.effectiveStaffLimit(v.id)).limit,
        payments: await this.prisma.venuePayment.findMany({
          where: { venueId: v.id },
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { plan: { select: { name: true } } },
        }),
      });
    }
    return out;
  }

  async reviews(user: AuthUser, venueId?: string, cursor?: string, rawLimit?: number) {
    const limit = pageLimit(rawLimit, 30);
    const ids = venueId ? [(await this.assertVenue(user, venueId)).id] : await this.venueIds(user);
    const rows = await this.prisma.review.findMany({
      where: { venueId: { in: ids }, ...keysetWhere(cursor, 'createdAt', 'desc') },
      include: { user: { select: { name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return {
      items: rows.slice(0, limit),
      nextCursor:
        rows.length > limit
          ? encodeCursor(rows[limit - 1].createdAt, rows[limit - 1].id)
          : null,
    };
  }

  async replyReview(user: AuthUser, reviewId: string, reply: string) {
    const review = await this.prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) throw new NotFoundException('Review not found');
    await this.assertVenue(user, review.venueId);
    return this.reviewOps.replyToReview(reviewId, reply);
  }
}
