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
    await this.prisma.sport.delete({ where: { id } });
    return { deleted: true };
  }

  /** Map free-text names to the catalog's canonical spelling; unknown or inactive sports are rejected. */
  async normalizeSports(names: string[]): Promise<string[]> {
    const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    if (clean.length === 0) return [];
    const catalog = await this.prisma.sport.findMany({
      where: { isActive: true },
      select: { name: true },
    });
    const byLower = new Map(catalog.map((s) => [s.name.toLowerCase(), s.name]));
    const out: string[] = [];
    for (const n of clean) {
      const hit = byLower.get(n.toLowerCase());
      if (!hit) {
        throw new BadRequestException(
          `"${n}" is not in the sports catalog — sports are managed by the super admin`,
        );
      }
      out.push(hit);
    }
    return out;
  }

  async normalizeSport(name: string): Promise<string> {
    const [hit] = await this.normalizeSports([name]);
    if (!hit) throw new BadRequestException(`"${name}" is not in the sports catalog`);
    return hit;
  }
}
