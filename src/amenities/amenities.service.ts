import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma';
import { CreateAmenityDto, UpdateAmenityDto } from './dto';

/**
 * The amenities catalog is owned by the super admin, mirroring the
 * sports catalog. Venues may only list catalog amenities (names are
 * normalized to the catalog spelling), so amenity labels never
 * fragment over free-text variants ("car parking" vs "Parking").
 */
@Injectable()
export class AmenitiesService {
  constructor(private prisma: PrismaService) {}

  listActive() {
    return this.prisma.amenity.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async listAll() {
    const [amenities, venues] = await Promise.all([
      this.prisma.amenity.findMany({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.venue.findMany({ select: { amenities: true } }),
    ]);
    const use = new Map<string, number>();
    for (const v of venues)
      for (const a of v.amenities)
        use.set(a.toLowerCase(), (use.get(a.toLowerCase()) ?? 0) + 1);
    return amenities.map((a) => ({
      ...a,
      venuesUsing: use.get(a.name.toLowerCase()) ?? 0,
    }));
  }

  async create(dto: CreateAmenityDto) {
    const name = dto.name.trim();
    const exists = await this.prisma.amenity.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (exists) throw new ConflictException(`Amenity "${name}" already exists`);
    return this.prisma.amenity.create({
      data: { name, sortOrder: dto.sortOrder ?? 0 },
    });
  }

  async update(id: string, dto: UpdateAmenityDto) {
    const amenity = await this.prisma.amenity.findUnique({ where: { id } });
    if (!amenity) throw new NotFoundException('Amenity not found');
    const data: { name?: string; sortOrder?: number; isActive?: boolean } = {};
    if (dto.name !== undefined) {
      data.name = dto.name.trim();
      const exists = await this.prisma.amenity.findFirst({
        where: { id: { not: id }, name: { equals: data.name, mode: 'insensitive' } },
      });
      if (exists) throw new ConflictException(`Amenity "${data.name}" already exists`);
    }
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    const renamed = data.name !== undefined && data.name !== amenity.name;
    if (renamed) {
      // Round 5, D5-S52 (amenities equivalent): the rename used to
      // run as a bare update followed by a per-venue loop with no
      // transaction — a crash mid-rename left some venues on the old
      // name. One transaction now, so the rename is atomic.
      const oldName = amenity.name;
      const newName = data.name as string;
      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.amenity.update({ where: { id }, data });
        const venues = await tx.venue.findMany({
          where: { amenities: { has: oldName } },
          select: { id: true, amenities: true },
        });
        for (const v of venues) {
          await tx.venue.update({
            where: { id: v.id },
            data: { amenities: v.amenities.map((a) => (a === oldName ? newName : a)) },
          });
        }
        return updated;
      });
    }
    return this.prisma.amenity.update({ where: { id }, data });
  }

  async remove(id: string) {
    const amenity = await this.prisma.amenity.findUnique({ where: { id } });
    if (!amenity) throw new NotFoundException('Amenity not found');
    const venueUse = await this.prisma.venue.count({
      where: { amenities: { has: amenity.name } },
    });
    if (venueUse > 0) {
      throw new ConflictException(
        `"${amenity.name}" is used by ${venueUse} venue(s) — deactivate it instead of deleting it`,
      );
    }
    await this.prisma.amenity.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Map free-text names to the catalog's canonical spelling. Unknown or
   * inactive names are rejected — unless grandfathered (already on the
   * venue being edited), mirroring the sports catalog rule.
   */
  async normalizeAmenities(
    names: string[],
    opts?: { grandfathered?: string[] },
  ): Promise<string[]> {
    const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (clean.length === 0) return [];
    const catalog = await this.prisma.amenity.findMany({
      where: { isActive: true },
      select: { name: true },
    });
    const byLower = new Map(catalog.map((a) => [a.name.toLowerCase(), a.name]));
    const grand = new Map(
      (opts?.grandfathered ?? []).map((g) => [g.toLowerCase(), g] as const),
    );
    const out: string[] = [];
    for (const n of clean) {
      const hit = byLower.get(n.toLowerCase());
      if (hit) {
        out.push(hit);
        continue;
      }
      const kept = grand.get(n.toLowerCase());
      if (kept) {
        out.push(kept);
        continue;
      }
      throw new BadRequestException(
        `"${n}" is not in the amenities list — pick from the standard amenities`,
      );
    }
    return out;
  }
}
