import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { minutesSinceMidnight, startOfToday } from '../common/date.util';
import { NotificationsService } from '../notifications/notifications.service';
import { ReferralsService } from '../promos/referrals.service';
import { PlansService } from '../plans/plans.service';
import { BookingsService } from '../bookings/bookings.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private referrals: ReferralsService,
    private plans: PlansService,
    private bookings: BookingsService,
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
      select: {
        id: true,
        userId: true,
        courtId: true,
        date: true,
        startMinutes: true,
        endMinutes: true,
        venue: { select: { name: true } },
      },
    });
    let expired = 0;
    for (const b of stale) {
      // Atomic claim: the status condition inside the UPDATE means an
      // owner accepting between the find and this write wins — the
      // just-confirmed booking is never overwritten to cancelled.
      const claimed = await this.prisma.booking.updateMany({
        where: { id: b.id, status: BookingStatus.pending },
        data: { status: BookingStatus.cancelled },
      });
      if (claimed.count === 0) continue;
      expired++;
      await this.bookings.rejectPendingReschedules(b.id, 'Booking expired');
      await this.bookings.releasePromo(b.id);
      await this.bookings.notifyWaitlist(b);
      if (b.userId) {
        await this.notifications.notifyPlayerDecision(b.userId, false, b.venue.name, '', 'The arena did not respond in time');
      }
    }
    if (expired > 0) this.logger.log(`Expired ${expired} pending bookings`);
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

    // Game posts starting within 2 hours: remind the host and everyone
    // who joined — board games previously had no reminder at all.
    const games = await this.prisma.gamePost.findMany({
      where: {
        status: { in: ['open', 'full'] },
        date: today,
        reminderSent: false,
        startMinutes: { gt: nowMin, lte: nowMin + 120 },
      },
      include: {
        participants: {
          where: { status: 'joined' },
          select: { userId: true },
        },
        venue: { select: { name: true } },
        booking: { select: { totalPrice: true, discountAmount: true } },
      },
    });
    for (const g of games) {
      const hh = String(Math.floor(g.startMinutes / 60)).padStart(2, '0');
      const mm = String(g.startMinutes % 60).padStart(2, '0');
      // Joiners owe their share at the venue — say so while there's
      // still time to bring cash. The host collects; they get no line.
      let pricePerPlayer: number | null = null;
      if (g.booking) {
        const fee = Math.max(
          0,
          Number(g.booking.totalPrice) - Number(g.booking.discountAmount),
        );
        const squad =
          g.squadSize != null
            ? g.squadSize + g.playersNeeded
            : g.playersNeeded + 1;
        if (squad > 0) pricePerPlayer = Math.round(fee / squad);
      }
      const targets = new Set<string>([g.creatorId]);
      for (const p of g.participants) if (p.userId) targets.add(p.userId);
      for (const uid of targets) {
        await this.notifications
          .pushToUser(uid, {
            title: 'Game reminder',
            body:
              `Your ${g.sport} game starts at ${hh}:${mm}${g.venue ? ` at ${g.venue.name}` : ` in ${g.city}`}. See you there!` +
              (uid !== g.creatorId && pricePerPlayer
                ? ` Bring Rs ${pricePerPlayer} — your share of the court fee, paid at the venue.`
                : ''),
            data: { type: 'game_reminder' },
          })
          .catch(() => {});
      }
      await this.prisma.gamePost.update({
        where: { id: g.id },
        data: { reminderSent: true },
      });
    }
  }

  /**
   * Game posts whose match start has passed have done their job. Close
   * them (never delete) so the status stays truthful everywhere — board
   * filters, direct links, host history and admin views — instead of
   * lingering as `open`/`full` forever. The board's own time filter
   * already hides them between sweeps.
   */
  @Cron('*/15 * * * *')
  async closeExpiredGamePosts() {
    const today = startOfToday();
    const nowMin = minutesSinceMidnight();
    const res = await this.prisma.gamePost.updateMany({
      where: {
        status: { in: ['open', 'full'] },
        OR: [
          { date: { lt: today } },
          { date: today, startMinutes: { lte: nowMin } },
        ],
      },
      data: { status: 'closed' },
    });
    if (res.count > 0) {
      this.logger.log(`Closed ${res.count} expired game posts`);
    }
  }

  /**
   * Nightly housekeeping: auth tables grow on every login/refresh/OTP —
   * drop expired sessions, week-old revocations and day-old OTP rows.
   */
  /** Venue plan billing: pause overdue venues, remind on due dates. */
  @Cron('30 0 * * *')
  async billingSweep() {
    const result = await this.plans.sweepBilling();
    if (result.paused > 0 || result.resumed > 0) {
      this.logger.log(
        `Billing sweep: ${result.checked} venues, ${result.paused} paused, ${result.resumed} resumed`,
      );
    }
  }

  @Cron('0 3 * * *')
  async pruneAuthData() {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);
    const dayAgo = new Date(now.getTime() - 24 * 3600_000);
    const sessions = await this.prisma.refreshSession.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: weekAgo } }],
      },
    });
    const otps = await this.prisma.otpCode.deleteMany({
      where: { expiresAt: { lt: dayAgo } },
    });
    if (sessions.count > 0 || otps.count > 0) {
      this.logger.log(
        `Pruned ${sessions.count} refresh sessions, ${otps.count} OTP rows`,
      );
    }
  }

  /** Nightly: complete past bookings, pay out referral rewards, recompute badges. */
  @Cron('0 2 * * *')
  async nightly() {
    const now = new Date();
    const today = startOfToday();
    // Booking dates are stored as UTC midnights, so "up to today" is
    // everything before tomorrow's local midnight.
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 1. No-show sweep FIRST: past confirmed bookings that were never
    // checked in become no-shows (with strikes, via the shared
    // markNoShow path) — not completions. The slot end is play-date +
    // end time, so an overnight booking ending after 02:00 is not
    // swept early.
    const unchecked = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.confirmed,
        checkedInAt: null,
        date: { lt: tomorrow },
      },
      select: { id: true, date: true, endMinutes: true },
    });
    let noShows = 0;
    for (const b of unchecked) {
      if (this.bookings.slotEnded(b, now)) {
        await this.bookings.markNoShow(b.id);
        noShows++;
      }
    }
    if (noShows > 0) this.logger.log(`Marked ${noShows} bookings as no-show`);

    // 2. Past CHECKED-IN bookings → completed (unlocks reviews). A
    // booking nobody checked into is a no-show by now (step 1), never
    // a game that was played.
    const checkedIn = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.confirmed,
        checkedInAt: { not: null },
        date: { lt: tomorrow },
      },
      select: { id: true, date: true, endMinutes: true },
    });
    const doneIds = checkedIn
      .filter((b) => this.bookings.slotEnded(b, now))
      .map((b) => b.id);
    if (doneIds.length > 0) {
      await this.prisma.booking.updateMany({
        where: { id: { in: doneIds } },
        data: { status: BookingStatus.completed },
      });
      await this.prisma.rescheduleRequest.updateMany({
        where: { bookingId: { in: doneIds }, status: 'pending' },
        data: {
          status: 'rejected',
          reason: 'Booking is no longer active',
          decidedAt: new Date(),
        },
      });
    }
    this.logger.log(`Auto-completed ${doneIds.length} bookings`);

    // 3. Referral rewards: referee's first completed booking → reward the referrer.
    const { granted } = await this.referrals.grantReferralRewards();
    if (granted > 0) this.logger.log(`Referral rewards granted: ${granted}`);

    // 4. Badge eligibility (simple v1 rule; refined with real data later).
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
