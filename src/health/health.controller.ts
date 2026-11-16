import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth';
import { PrismaService } from '../common/prisma';
import { NotificationsService } from '../notifications/notifications.service';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    // Round 4, P-S16: the old endpoint returned HTTP 200 even when
    // the database was down (Nest's default status on a returned
    // object) — an orchestrator or `depends_on: service_healthy`
    // gate treating any 200 as healthy could never fail. A down DB
    // is now a real 503.
    //
    // Round 5, D5-S40: 200 also hid three more broken states, all
    // now reflected honestly in the `degraded` reasons array, which
    // flips the status to 503 whenever it is non-empty:
    // - (a) FCM enabled but unconfigured at runtime: 503. (FCM init
    //   failure hard-fails boot, so a running app with FCM enabled
    //   is configured by construction — this reason is the
    //   defence-in-depth signal if that ever stops being true.)
    // - (b) wrong DB timezone: 503 (the boot guard only runs at
    //   boot, so a drifted cluster stayed 200 forever after);
    // - (c) migration/drift: 503. Besides the _prisma_migrations
    //   folder check, an information_schema check proves the newest
    //   columns actually exist (Court.weeklyHoursVersion,
    //   Broadcast.countsReliable, Broadcast.delivered) — a
    //   db-push DB passes this (push creates the columns) while a
    //   half-migrated DB fails it even when SELECT 1 succeeds.
    let db = 'up';
    let dbTimezone: string | null = null;
    let tzOk = true;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const rows = await this.prisma.$queryRaw<{ TimeZone: string }[]>`SHOW timezone`;
      dbTimezone = rows[0]?.TimeZone ?? null;
      tzOk = !dbTimezone || dbTimezone === 'Asia/Karachi';
    } catch {
      db = 'down';
    }
    const migrations: {
      status: 'ok' | 'pending' | 'failed' | 'unknown';
      pending: string[];
      failed: string[];
    } = { status: 'unknown', pending: [], failed: [] };
    if (db === 'up') {
      try {
        const rows = await this.prisma.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
          SELECT migration_name, finished_at FROM _prisma_migrations`;
        const finished = new Set(
          rows.filter((r) => r.finished_at !== null).map((r) => r.migration_name),
        );
        const failed = await this.prisma.$queryRaw<{ migration_name: string }[]>`
          SELECT migration_name FROM _prisma_migrations
          WHERE finished_at IS NULL AND rolled_back_at IS NULL`;
        migrations.failed = failed.map((r) => r.migration_name);
        const dir = path.join(process.cwd(), 'prisma', 'migrations');
        let folders: string[] | null = null;
        try {
          folders = fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && /^\d/.test(d.name))
            .map((d) => d.name);
        } catch {
          folders = null; // migrations dir not readable here — cannot verify
        }
        if (folders !== null) {
          migrations.pending = folders.filter((f) => !finished.has(f));
          migrations.status =
            migrations.failed.length > 0
              ? 'failed'
              : migrations.pending.length > 0
                ? 'pending'
                : 'ok';
        } else if (migrations.failed.length > 0) {
          migrations.status = 'failed';
        }
      } catch (e) {
        // No _prisma_migrations table = db-push DB: provenance is
        // unrecorded, not verified — report unknown, do not flip.
        if (!/does not exist/i.test((e as Error).message)) {
          migrations.status = 'unknown';
        }
      }
    }
    // Round 5, D5-S40 (c): drift check against information_schema —
    // the newest columns must exist, whatever the migration rows say.
    const drift: string[] = [];
    if (db === 'up') {
      try {
        const cols = await this.prisma.$queryRaw<{ column_name: string }[]>`
          SELECT column_name FROM information_schema.columns
          WHERE (table_name = 'Court' AND column_name = 'weeklyHoursVersion')
             OR (table_name = 'Broadcast' AND column_name IN ('countsReliable', 'delivered'))`;
        const found = new Set(cols.map((c) => c.column_name));
        const missing = ['weeklyHoursVersion', 'countsReliable', 'delivered'].filter(
          (c) => !found.has(c),
        );
        if (missing.length > 0) drift.push(`drift: missing columns ${missing.join(', ')}`);
      } catch {
        drift.push('drift: column check failed');
      }
    }
    const fcm = this.notifications.fcmStatus();
    const pushHealthy = !fcm.enabled || fcm.configured;
    const degraded: string[] = [];
    if (db !== 'up') degraded.push('db-down');
    if (!tzOk) degraded.push(`db-timezone-mismatch: ${dbTimezone}`);
    if (!pushHealthy) degraded.push('fcm-enabled-but-unconfigured');
    if (migrations.failed.length > 0) degraded.push('migrations-failed');
    if (migrations.pending.length > 0) degraded.push('migrations-pending');
    degraded.push(...drift);
    const ok = degraded.length === 0;
    if (!ok) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return {
      ok,
      db,
      dbTimezone,
      fcm,
      // Never claims healthy when pushes are down: enabled-but-
      // unconfigured is healthy=false and now also flips the status
      // code via `degraded` (see above).
      push: { ...fcm, healthy: pushHealthy },
      degraded,
      migrations,
    };
  }
}
