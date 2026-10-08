import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, VenueStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthUser } from '../common/auth';
import { PrismaService } from '../common/prisma';
import { BookingsService } from '../bookings/bookings.service';
import { StorageService } from '../storage/storage.service';
import { ReviewsService } from '../reviews/reviews.service';
import { parseDateOnly, startOfToday } from '../common/date.util';
import {
  BookingsQueryDto,
  CreateBlockDto,
  CreateCourtDto,
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
    private storage: StorageService,
    private reviewOps: ReviewsService,
  ) {}

  // ------------------------------------------------------------ access scope
  /** Venue ids the user may operate: owned (owner) or assigned (staff). */
  async venueIds(user: AuthUser): Promise<string[]> {
    if (user.permissions.includes('venues.manage')) {
      const vs = await this.prisma.venue.findMany({
        where: { ownerId: user.id },
        select: { id: true },
      });
      return vs.map((v) => v.id);
    }
    const links = await this.prisma.venueStaff.findMany({
      where: { userId: user.id },
      select: { venueId: true },
    });
    return links.map((l) => l.venueId);
  }

  async assertVenue(user: AuthUser, venueId: string) {
    const ids = await this.venueIds(user);
    if (!ids.includes(venueId)) throw new ForbiddenException('Not your venue');
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId } });
    if (!venue) throw new NotFoundException('Venue not found');
    return venue;
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
          venueId: { in: ids },
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
      .filter((b) => b.status === BookingStatus.confirmed || b.status === BookingStatus.completed)
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
  async listMyVenues(user: AuthUser) {
    const ids = await this.venueIds(user);
    return this.prisma.venue.findMany({
      where: { id: { in: ids } },
      include: { _count: { select: { courts: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createVenue(user: AuthUser, dto: CreateVenueDto) {
    const venue = await this.prisma.venue.create({
      data: {
        ownerId: user.id,
        name: dto.name,
        address: dto.address,
        city: dto.city,
        lat: dto.lat,
        lng: dto.lng,
        sports: dto.sports ?? [],
        amenities: dto.amenities ?? [],
        status: VenueStatus.draft,
      },
    });
    // Default staff roles: attach the venue's allowed roles (set by super admin;
    // fall back to all arena-scope roles so the owner isn't blocked).
    const allowed = await this.prisma.role.findMany({ where: { scope: 'arena' } });
    if (allowed.length > 0) {
      await this.prisma.venueAllowedRole.createMany({
        data: allowed.map((r) => ({ venueId: venue.id, roleId: r.id })),
        skipDuplicates: true,
      });
    }
    return venue;
  }

  async updateVenue(user: AuthUser, venueId: string, dto: UpdateVenueDto) {
    await this.assertVenue(user, venueId);
    if (!user.permissions.includes('venues.manage')) {
      throw new ForbiddenException('Only the owner can edit venue settings');
    }
    return this.prisma.venue.update({ where: { id: venueId }, data: dto });
  }

  async submitVenue(user: AuthUser, venueId: string) {
    await this.assertVenue(user, venueId);
    if (!user.permissions.includes('venues.manage')) {
      throw new ForbiddenException('Only the owner can submit a venue');
    }
    const courts = await this.prisma.court.count({ where: { venueId, isActive: true } });
    if (courts === 0) throw new BadRequestException('Add at least one court before submitting');
    return this.prisma.venue.update({
      where: { id: venueId },
      data: { status: VenueStatus.pending },
    });
  }

  async addVenueImage(user: AuthUser, venueId: string, file: Express.Multer.File) {
    const venue = await this.assertVenue(user, venueId);
    const url = await this.storage.saveVenueImage(venueId, file);
    return this.prisma.venue.update({
      where: { id: venueId },
      data: { images: [...venue.images, url] },
    });
  }

  async removeVenueImage(user: AuthUser, venueId: string, url: string) {
    const venue = await this.assertVenue(user, venueId);
    await this.storage.deleteImage(url);
    return this.prisma.venue.update({
      where: { id: venueId },
      data: { images: venue.images.filter((i) => i !== url) },
    });
  }

  // ---------------------------------------------------------------- courts
  async courts(user: AuthUser, venueId: string) {
    await this.assertVenue(user, venueId);
    return this.prisma.court.findMany({ where: { venueId }, orderBy: { name: 'asc' } });
  }

  async createCourt(user: AuthUser, venueId: string, dto: CreateCourtDto) {
    await this.assertVenue(user, venueId);
    return this.prisma.court.create({ data: { venueId, ...dto } });
  }

  async updateCourt(user: AuthUser, courtId: string, dto: UpdateCourtDto) {
    const court = await this.prisma.court.findUnique({ where: { id: courtId } });
    if (!court) throw new NotFoundException('Court not found');
    await this.assertVenue(user, court.venueId);
    return this.prisma.court.update({ where: { id: courtId }, data: dto });
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

  // --------------------------------------------------------------- bookings
  async bookings(user: AuthUser, query: BookingsQueryDto) {
    const ids = query.venueId
      ? [(await this.assertVenue(user, query.venueId)).id]
      : await this.venueIds(user);
    return this.prisma.booking.findMany({
      where: {
        venueId: { in: ids },
        ...(query.date ? { date: parseDateOnly(query.date) } : {}),
        ...(query.status ? { status: query.status as BookingStatus } : {}),
      },
      include: {
        court: { select: { name: true, sport: true } },
        venue: { select: { name: true } },
        user: { select: { name: true, phone: true } },
        _count: { select: { participants: true } },
      },
      orderBy: [{ date: 'desc' }, { startMinutes: 'desc' }],
      take: 200,
    });
  }

  async acceptBooking(user: AuthUser, bookingId: string) {
    await this.ownedBooking(user, bookingId);
    return this.bookingOps.acceptBooking(bookingId);
  }

  async rejectBooking(user: AuthUser, bookingId: string, reason?: string) {
    await this.ownedBooking(user, bookingId);
    return this.bookingOps.rejectBooking(bookingId, reason);
  }

  async acceptSeries(user: AuthUser, recurrenceId: string, venueId: string) {
    await this.assertVenue(user, venueId);
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
  async reschedules(user: AuthUser, status = 'pending') {
    const ids = await this.venueIds(user);
    return this.prisma.rescheduleRequest.findMany({
      where: { booking: { venueId: { in: ids } }, status },
      include: {
        booking: {
          include: {
            court: { select: { name: true } },
            user: { select: { name: true, phone: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async acceptReschedule(user: AuthUser, requestId: string) {
    const req = await this.prisma.rescheduleRequest.findUnique({
      where: { id: requestId },
      include: { booking: true },
    });
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'pending') throw new BadRequestException('Request already decided');
    await this.assertVenue(user, req.booking.venueId);

    const court = await this.prisma.court.findUniqueOrThrow({ where: { id: req.booking.courtId } });
    const { startMinutes, endMinutes } = {
      startMinutes: req.requestedStartMinutes,
      endMinutes: req.requestedEndMinutes,
    };
    // Alignment + hours.
    if (
      startMinutes < court.openMinutes ||
      endMinutes > court.closeMinutes ||
      (startMinutes - court.openMinutes) % court.slotMinutes !== 0
    ) {
      throw new BadRequestException('Requested slot is outside court hours');
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

    const [booking] = await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: req.bookingId },
        data: {
          date: req.requestedDate,
          startMinutes,
          endMinutes,
          status: BookingStatus.confirmed,
        },
      }),
      this.prisma.rescheduleRequest.update({
        where: { id: requestId },
        data: { status: 'approved', decidedAt: new Date() },
      }),
    ]);
    return booking;
  }

  async rejectReschedule(user: AuthUser, requestId: string, reason?: string) {
    const req = await this.prisma.rescheduleRequest.findUnique({
      where: { id: requestId },
      include: { booking: true },
    });
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'pending') throw new BadRequestException('Request already decided');
    await this.assertVenue(user, req.booking.venueId);
    return this.prisma.rescheduleRequest.update({
      where: { id: requestId },
      data: { status: 'rejected', reason, decidedAt: new Date() },
    });
  }

  // ------------------------------------------------------------------ staff
  /** Roles the super admin enabled for this venue — the only ones the owner may hand out. */
  async allowedRoles(user: AuthUser, venueId: string) {
    await this.assertVenue(user, venueId);
    const links = await this.prisma.venueAllowedRole.findMany({
      where: { venueId },
      include: { role: true },
    });
    return links.map((l) => l.role);
  }

  async staffList(user: AuthUser, venueId: string) {
    await this.assertVenue(user, venueId);
    return this.prisma.venueStaff.findMany({
      where: { venueId },
      include: { user: { select: { id: true, name: true, email: true, role: { select: { name: true } } } } },
    });
  }

  async createStaff(user: AuthUser, venueId: string, dto: CreateStaffDto) {
    await this.assertVenue(user, venueId);
    // The role must be one the super admin allowed for this arena.
    const allowed = await this.prisma.venueAllowedRole.findUnique({
      where: { venueId_roleId: { venueId, roleId: dto.roleId } },
      include: { role: true },
    });
    if (!allowed) throw new ForbiddenException('This role is not enabled for your arena');
    if (allowed.role.scope !== 'arena' || allowed.role.name === 'owner') {
      throw new ForbiddenException('Cannot assign this role to team members');
    }
    const email = dto.email.toLowerCase().trim();
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException('Email already registered');

    const member = await this.prisma.user.create({
      data: {
        email,
        name: dto.name,
        passwordHash: await bcrypt.hash(dto.password, 10),
        roleId: dto.roleId,
      },
    });
    await this.prisma.venueStaff.create({ data: { venueId, userId: member.id } });
    const { passwordHash: _p, ...safe } = member;
    return safe;
  }

  async removeStaff(user: AuthUser, staffLinkId: string) {
    const link = await this.prisma.venueStaff.findUnique({ where: { id: staffLinkId } });
    if (!link) throw new NotFoundException('Team member not found');
    await this.assertVenue(user, link.venueId);
    return this.prisma.venueStaff.delete({ where: { id: staffLinkId } });
  }

  // --------------------------------------------------------------- customers
  async customers(user: AuthUser, venueId?: string) {
    const ids = venueId ? [(await this.assertVenue(user, venueId)).id] : await this.venueIds(user);
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
    return [...map.values()].sort((a, b) => b.visits - a.visits);
  }

  // ---------------------------------------------------------------- reviews
  async reviews(user: AuthUser, venueId?: string) {
    const ids = venueId ? [(await this.assertVenue(user, venueId)).id] : await this.venueIds(user);
    return this.prisma.review.findMany({
      where: { venueId: { in: ids } },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async replyReview(user: AuthUser, reviewId: string, reply: string) {
    const review = await this.prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) throw new NotFoundException('Review not found');
    await this.assertVenue(user, review.venueId);
    return this.reviewOps.replyToReview(reviewId, reply);
  }
}
