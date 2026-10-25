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
    // now reflected honestly:
    // - wrong DB timezone: 503 (the boot guard only runs at boot, so
    //   a drifted cluster stayed 200 forever after);
    // - failed / pending migrations: 503 (a failed _prisma_migrations
    //   row, or a migration folder with no finished row — the
    //   db-push case stays 503 until resolved, which is the honest
    //   state: schema provenance is unrecorded);
    // - push outage: reported as a `push` field that never claims
    //   healthy when pushes are down (enabled but unconfigured).
    //   Push alone does NOT flip the status code: FCM init failure
    //   hard-fails boot, so a running app with FCM enabled is
    //   configured by construction, and log-only push in dev is not
    //   an outage. `degraded: true` is the signal for that case.
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
    const fcm = this.notifications.fcmStatus();
    const pushHealthy = !fcm.enabled || fcm.configured;
    const ok =
      db === 'up' &&
      tzOk &&
      migrations.failed.length === 0 &&
      migrations.pending.length === 0;
    if (!ok) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return {
      ok,
      db,
      dbTimezone,
      fcm,
      // Never claims healthy when pushes are down: enabled-but-
      // unconfigured is healthy=false even though it does not flip
      // the status code (see above).
      push: { ...fcm, healthy: pushHealthy },
      degraded: !pushHealthy,
      migrations,
    };
  }
}
