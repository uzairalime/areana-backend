import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma';
import { CreateSportDto, UpdateSportDto } from './dto';

/**
 * The sports catalog is owned by the super admin. Venues and courts may
 * only use catalog sports (names are normalized to the catalog spelling),
 * so filters and search never fragment over typos ("Foot Ball" etc.).
 */
@Injectable()
export class SportsService {
  constructor(private prisma: PrismaService) {}

  listActive() {
    return this.prisma.sport.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async listAll() {
    const [sports, venues, courts] = await Promise.all([
      this.prisma.sport.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.venue.findMany({ select: { sports: true } }),
      this.prisma.court.findMany({ select: { sport: true } }),
    ]);
    const venueUse = new Map<string, number>();
    for (const v of venues)
      for (const s of v.sports)
        venueUse.set(s.toLowerCase(), (venueUse.get(s.toLowerCase()) ?? 0) + 1);
    const courtUse = new Map<string, number>();
    for (const c of courts)
      courtUse.set(c.sport.toLowerCase(), (courtUse.get(c.sport.toLowerCase()) ?? 0) + 1);
    return sports.map((s) => ({
      ...s,
      venuesUsing: venueUse.get(s.name.toLowerCase()) ?? 0,
      courtsUsing: courtUse.get(s.name.toLowerCase()) ?? 0,
    }));
  }

  async create(dto: CreateSportDto) {
    const name = dto.name.trim();
    const exists = await this.prisma.sport.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (exists) throw new ConflictException(`Sport "${name}" already exists`);
    return this.prisma.sport.create({
      data: { name, icon: dto.icon?.trim() || null, sortOrder: dto.sortOrder ?? 0 },
    });
  }

  async update(id: string, dto: UpdateSportDto) {
    const sport = await this.prisma.sport.findUnique({ where: { id } });
    if (!sport) throw new NotFoundException('Sport not found');
    const data: { name?: string; icon?: string | null; sortOrder?: number; isActive?: boolean } = {};
    if (dto.name !== undefined) {
      data.name = dto.name.trim();
      const exists = await this.prisma.sport.findFirst({
        where: { id: { not: id }, name: { equals: data.name, mode: 'insensitive' } },
      });
      if (exists) throw new ConflictException(`Sport "${data.name}" already exists`);
    }
    if (dto.icon !== undefined) data.icon = dto.icon?.trim() || null;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    const renamed = data.name !== undefined && data.name !== sport.name;
    if (renamed) {
      // Round 5, D5-S52: the rename used to run as a bare update
      // followed by a per-venue loop with no transaction — a crash
      // (or a concurrent venue/court create using the old name)
      // mid-rename left courts on the new name while some venues
      // and their photo sport tags still carried the old one.
      // Everything now runs in one transaction, so the rename is
      // atomic: either every reference moves or none does.
      const oldName = sport.name;
      const newName = data.name as string;
      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.sport.update({ where: { id }, data });
        await tx.court.updateMany({ where: { sport: oldName }, data: { sport: newName } });
        const venues = await tx.venue.findMany({
          where: { sports: { has: oldName } },
          select: { id: true, sports: true, photos: true },
        });
        for (const v of venues) {
          const photos = Array.isArray(v.photos)
            ? (v.photos as Record<string, unknown>[]).map((e) =>
                e && e.sport === oldName ? { ...e, sport: newName } : e,
              )
            : v.photos;
          await tx.venue.update({
            where: { id: v.id },
            data: {
              sports: v.sports.map((s) => (s === oldName ? newName : s)),
              photos: photos as never,
            },
          });
        }
        return updated;
      });
    }
    return this.prisma.sport.update({ where: { id }, data });
  }

  async remove(id: string) {
    const sport = await this.prisma.sport.findUnique({ where: { id } });
    if (!sport) throw new NotFoundException('Sport not found');
    const [venueUse, courtUse] = await Promise.all([
      this.prisma.venue.count({ where: { sports: { has: sport.name } } }),
      this.prisma.court.count({ where: { sport: sport.name } }),
    ]);
    if (venueUse + courtUse > 0) {
      throw new ConflictException(
        `"${sport.name}" is used by ${venueUse} venue(s) and ${courtUse} court(s) — deactivate it instead of deleting it`,
      );
    }
    // Round 5, D5-S52 (remove half; the rename half already runs in
    // one transaction): the count above used to be followed by a bare
    // delete, so a venue/court created with this name in between left
    // a dangling name that normalizeSport then rejects for new venues.
    // Re-count inside a transaction holding the sport row lock; the
    // lock serializes against concurrent catalog-name writes that
    // take the same row. (The amenities equivalent lives in
    // src/amenities/amenities.service.ts, outside this round's file
    // set — its remove has the identical count-then-delete shape and
    // still needs the same fix from its owner.)
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Sport" WHERE id = ${id} FOR UPDATE`;
      const [venueNow, courtNow] = await Promise.all([
        tx.venue.count({ where: { sports: { has: sport.name } } }),
        tx.court.count({ where: { sport: sport.name } }),
      ]);
      if (venueNow + courtNow > 0) {
        throw new ConflictException(
          `"${sport.name}" is used by ${venueNow} venue(s) and ${courtNow} court(s) — deactivate it instead of deleting it`,
        );
      }
      await tx.sport.delete({ where: { id } });
    });
    return { deleted: true };
  }

  /**
   * Map free-text names to the catalog's canonical spelling. Unknown
   * sports are rejected; INACTIVE sports are rejected too — unless the
   * name is grandfathered (already in use by the entity being edited),
   * so deactivating a sport never locks an owner out of saving an
   * unrelated change to their own arena.
   */
  async normalizeSports(
    names: string[],
    opts?: { grandfathered?: string[] },
  ): Promise<string[]> {
    const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (clean.length === 0) return [];
    const catalog = await this.prisma.sport.findMany({
      where: { isActive: true },
      select: { name: true },
    });
    const byLower = new Map(catalog.map((s) => [s.name.toLowerCase(), s.name]));
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
      // Distinguish "not in the catalog at all" from "deactivated".
      const any = await this.prisma.sport.findFirst({
        where: { name: { equals: n, mode: 'insensitive' } },
        select: { name: true, isActive: true },
      });
      if (any && !any.isActive) {
        throw new BadRequestException(
          `"${any.name}" has been deactivated by the super admin and can't be newly selected`,
        );
      }
      throw new BadRequestException(
        `"${n}" is not in the sports catalog — sports are managed by the super admin`,
      );
    }
    return out;
  }

  async normalizeSport(name: string, grandfathered?: string): Promise<string> {
    const [hit] = await this.normalizeSports([name], {
      grandfathered: grandfathered ? [grandfathered] : undefined,
    });
    if (!hit) throw new BadRequestException(`"${name}" is not in the sports catalog`);
    return hit;
  }
}
