import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { CreateBannerDto, SendBroadcastDto, UpdateBannerDto } from './dto';

/** Service only — the admin module wires the HTTP routes. */
@Injectable()
export class BroadcastsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Counts targeted devices. Actual push sending is wired later by the
   * notifications layer; this resolves the audience query.
   */
  async sendBroadcast(dto: SendBroadcastDto) {
    const where: Prisma.DeviceTokenWhereInput = {};
    if (dto.city) where.user = { city: dto.city };
    const targeted = await this.prisma.deviceToken.count({ where });
    return { targeted, title: dto.title };
  }

  listBanners(city?: string) {
    const now = new Date();
    const where: Prisma.BannerWhereInput = {
      isActive: true,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gte: now } }],
    };
    if (city) {
      where.AND = [{ OR: [{ city: null }, { city }] }];
    }
    return this.prisma.banner.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  createBanner(dto: CreateBannerDto) {
    return this.prisma.banner.create({
      data: {
        title: dto.title,
        imageUrl: dto.imageUrl,
        linkUrl: dto.linkUrl,
        city: dto.city,
        isActive: dto.isActive ?? true,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
      },
    });
  }

  async updateBanner(id: string, dto: UpdateBannerDto) {
    const banner = await this.prisma.banner.findUnique({ where: { id } });
    if (!banner) throw new NotFoundException('Banner not found');
    return this.prisma.banner.update({
      where: { id },
      data: {
        title: dto.title,
        imageUrl: dto.imageUrl,
        linkUrl: dto.linkUrl,
        city: dto.city,
        isActive: dto.isActive,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
      },
    });
  }

  async deleteBanner(id: string) {
    const banner = await this.prisma.banner.findUnique({ where: { id } });
    if (!banner) throw new NotFoundException('Banner not found');
    await this.prisma.banner.delete({ where: { id } });
    return { message: 'Banner deleted' };
  }
}
