import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth';
import { PrismaService } from '../common/prisma';
import { NotificationsService } from '../notifications/notifications.service';
import type { Response } from 'express';

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
    let db = 'up';
    let dbTimezone: string | null = null;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const rows = await this.prisma.$queryRaw<{ TimeZone: string }[]>`SHOW timezone`;
      dbTimezone = rows[0]?.TimeZone ?? null;
    } catch {
      db = 'down';
    }
    if (db === 'down') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    // Round 4, P-S8: health only ran SELECT 1, so it could not
    // distinguish "push working" from "push dead". FCM status is
    // reported alongside (enabled/configured) — but it does NOT flip
    // the overall status: push being log-only in dev is not an outage.
    return { ok: db === 'up', db, dbTimezone, fcm: this.notifications.fcmStatus() };
  }
}
