import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { minutesSinceMidnight, startOfToday } from '../common/date.util';
import { NotificationsService } from '../notifications/notifications.service';
import { ReferralsService } from '../promos/referrals.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private referrals: ReferralsService,
  ) {}

  private async setting(key: string, fallback: string): Promise<string> {
    const s = await this.prisma.setting.findUnique({ where: { key } });
    return s?.value ?? fallback;
  }

  /** Free slots whose owners never responded: pending → cancelled. */
  @Cron('*/15 * * * *')
  async expirePendingBookings() {
    const hours = parseFloat(await this.setting('pendingExpiryHours', '2'));
    const cutoff = new Date(Date.now() - hours * 3600_000);
    const stale = await this.prisma.booking.findMany({
      where: { status: BookingStatus.pending, createdAt: { lt: cutoff } },
      select: { id: true, userId: true, venue: { select: { name: true } } },
    });
    for (const b of stale) {
      await this.prisma.booking.update({
        where: { id: b.id },
        data: { status: BookingStatus.cancelled },
      });
      if (b.userId) {
        await this.notifications.notifyPlayerDecision(b.userId, false, b.venue.name, '', 'The arena did not respond in time');
      }
    }
    if (stale.length > 0) this.logger.log(`Expired ${stale.length} pending bookings`);
  }

  /** Remind players ~2h before their slot. */
  @Cron('*/30 * * * *')
  async sendReminders() {
    const today = startOfToday();
    const nowMin = minutesSinceMidnight();
    const upcoming = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.confirmed,
        date: today,
        reminderSent: false,
        startMinutes: { gt: nowMin, lte: nowMin + 120 },
      },
      include: { venue: { select: { name: true } } },
    });
    for (const b of upcoming) {
      if (!b.userId) continue;
      const hh = String(Math.floor(b.startMinutes / 60)).padStart(2, '0');
      const mm = String(b.startMinutes % 60).padStart(2, '0');
      await this.notifications.notifyBookingReminder(b.userId, b.venue.name, `${hh}:${mm}`);
      await this.prisma.booking.update({ where: { id: b.id }, data: { reminderSent: true } });
    }
  }

  /** Nightly: complete past bookings, pay out referral rewards, recompute badges. */
  @Cron('0 2 * * *')
  async nightly() {
    const today = startOfToday();

    // 1. Past confirmed bookings → completed (unlocks reviews).
    const done = await this.prisma.booking.updateMany({
      where: { status: BookingStatus.confirmed, date: { lt: today } },
      data: { status: BookingStatus.completed },
    });
    this.logger.log(`Auto-completed ${done.count} bookings`);

    // 2. Referral rewards: referee's first completed booking → reward the referrer.
    const { granted } = await this.referrals.grantReferralRewards();
    if (granted > 0) this.logger.log(`Referral rewards granted: ${granted}`);

    // 3. Badge eligibility (simple v1 rule; refined with real data later).
    const candidates = await this.prisma.venue.findMany({
      where: { status: 'approved', rating: { gte: 4.5 }, ratingCount: { gte: 5 } },
      select: { id: true },
    });
    const tier1 = await this.prisma.badge.findFirst({ where: { tier: 1 }, orderBy: { tier: 'asc' } });
    if (tier1) {
      for (const v of candidates) {
        await this.prisma.venueBadge.upsert({
          where: { venueId_badgeId: { venueId: v.id, badgeId: tier1.id } },
          update: {},
          create: { venueId: v.id, badgeId: tier1.id },
        });
      }
    }
  }
}
