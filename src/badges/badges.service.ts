import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma';
import { CreateBadgeDto, UpdateBadgeDto } from './dto';

/** Service only — the admin module wires the HTTP routes. */
@Injectable()
export class BadgesService {
  constructor(private prisma: PrismaService) {}

  listBadges() {
    return this.prisma.badge.findMany({
      include: { _count: { select: { venues: true } } },
      orderBy: { tier: 'asc' },
    });
  }

  createBadge(dto: CreateBadgeDto) {
    return this.prisma.badge.create({ data: dto });
  }

  async updateBadge(id: string, dto: UpdateBadgeDto) {
    const badge = await this.prisma.badge.findUnique({ where: { id } });
    if (!badge) throw new NotFoundException('Badge not found');
    return this.prisma.badge.update({ where: { id }, data: dto });
  }

  async deleteBadge(id: string) {
    const badge = await this.prisma.badge.findUnique({ where: { id } });
    if (!badge) throw new NotFoundException('Badge not found');
    await this.prisma.badge.delete({ where: { id } });
    return { message: 'Badge deleted' };
  }

  async grantBadge(venueId: string, badgeId: string, grantedById?: string) {
    const [venue, badge] = await Promise.all([
      this.prisma.venue.findUnique({ where: { id: venueId } }),
      this.prisma.badge.findUnique({ where: { id: badgeId } }),
    ]);
    if (!venue) throw new NotFoundException('Venue not found');
    if (!badge) throw new NotFoundException('Badge not found');
    return this.prisma.venueBadge.upsert({
      where: { venueId_badgeId: { venueId, badgeId } },
      update: { grantedAt: new Date(), grantedById },
      create: { venueId, badgeId, grantedById },
      include: { badge: true },
    });
  }

  async revokeBadge(venueId: string, badgeId: string) {
    await this.prisma.venueBadge.deleteMany({ where: { venueId, badgeId } });
    return { message: 'Badge revoked' };
  }
}
