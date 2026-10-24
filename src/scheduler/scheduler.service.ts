import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { minutesSinceMidnight, startOfToday } from '../common/date.util';
import { NotificationsService } from '../notifications/notifications.service';
import { ReferralsService } from '../promos/referrals.service';
import { PlansService } from '../plans/plans.service';
import { BookingsService } from '../bookings/bookings.service';

// Every cron in this service runs on Asia/Karachi wall time — the
// server's TZ is not trusted for business schedules (a host defaulting
// to UTC would silently shift every sweep by five hours).
const PKT = { timeZone: 'Asia/Karachi' } as const;

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private referrals: ReferralsService,
    private plans: PlansService,
    private bookings: BookingsService,
  ) {}

  /**
   * Startup catch-up (best-effort, never blocks boot): a restart
   * during the night must not skip a billing pause, and a restart
   * inside a booking's reminder window must not drop its reminder.
   */
  async onModuleInit() {
    await this.billingSweep().catch((e) =>
      this.logger.warn(`Startup billing sweep failed: ${(e as Error).message}`),
    );
    await this.sendReminders().catch((e) =>
      this.logger.warn(`Startup reminders failed: ${(e as Error).message}`),
    );
  }

  // In-process record of reminders this instance already sent (booking
  // id / game id → epoch ms). The catch-up pass ignores reminderSent,
  // so without this a booking reminded by the normal pass 30 minutes
  // ago would get a second ping in its last 30 minutes. Entries older
  // than an hour are pruned on each use; a booking only enters the
  // 30-minute window once per run cadence, so the window is ample.
  private bookingRemindedAt = new Map<string, number>();
  private gameRemindedAt = new Map<string, number>();

  private recentlyReminded(map: Map<string, number>, id: string): boolean {
    const now = Date.now();
    for (const [k, t] of map) {
      if (now - t > 60 * 60_000) map.delete(k);
    }
    return map.has(id);
  }

  private async setting(key: string, fallback: string): Promise<string> {
    const s = await this.prisma.setting.findUnique({ where: { key } });
    return s?.value ?? fallback;
  }

  /** Free slots whose owners never responded: pending → cancelled. */
  @Cron('*/15 * * * *', PKT)
  async expirePendingBookings() {
    const hours = parseFloat(await this.setting('pendingExpiryHours', '2'));
    // Slot-relative expiry: a pending booking expires at
    // min(slotStart, max(createdAt + pendingExpiryHours, slotStart − 24h)).
    // Creation-based expiry cancelled next-day bookings the owner had
    // barely had time to see, while letting same-day bookings linger
    // past their slot. The 24h floor keeps a last-minute request alive
    // until its slot, and the slotStart cap never lets a booking
    // outlive its game.
    const now = new Date();
    const candidates = await this.prisma.booking.findMany({
      where: { status: BookingStatus.pending },
      select: {
        id: true,
        userId: true,
        courtId: true,
        date: true,
        startMinutes: true,
        endMinutes: true,
        createdAt: true,
        venue: { select: { name: true } },
      },
    });
    const stale = candidates.filter((b) => {
      const slotStart = new Date(b.date);
      slotStart.setHours(
        Math.floor(b.startMinutes / 60),
        b.startMinutes % 60,
        0,
        0,
      );
      const expiryAt = Math.min(
        slotStart.getTime(),
        Math.max(
          b.createdAt.getTime() + hours * 3600_000,
          slotStart.getTime() - 24 * 3600_000,
        ),
      );
      return expiryAt <= now.getTime();
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

  /**
   * Remind players ~2h before their slot, plus a last-30-minutes
   * catch-up that runs on startup and every run. The catch-up covers
   * bookings the normal pass missed — accepted after the 2h window
   * opened, or created while the scheduler was down — regardless of
   * reminderSent (a flag set by a crashed instance must not swallow
   * the last reminder). The normal pass claims each row atomically
   * (updateMany where reminderSent=false): two instances racing the
   * same row get exactly one claim, so a booking is never reminded
   * twice from that path. The catch-up path dedupes in-process (see
   * recentlyReminded); a second instance that never sent the reminder
   * could still duplicate a catch-up ping — a duplicate reminder, not
   * a duplicate charge, and the deployment runs a single instance.
   */
  @Cron('*/30 * * * *', PKT)
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
      // Atomic claim: the reminderSent condition inside the UPDATE
      // means a second instance claiming the same row gets count 0
      // and skips — the booking is reminded exactly once from here.
      const claimed = await this.prisma.booking.updateMany({
        where: { id: b.id, reminderSent: false },
        data: { reminderSent: true },
      });
      if (claimed.count === 0) continue;
      const hh = String(Math.floor(b.startMinutes / 60)).padStart(2, '0');
      const mm = String(b.startMinutes % 60).padStart(2, '0');
      try {
        await this.notifications.notifyBookingReminder(b.userId, b.venue.name, `${hh}:${mm}`);
        this.bookingRemindedAt.set(b.id, Date.now());
      } catch {
        // Push failed after the claim: release the flag so a later
        // run retries instead of silently dropping the reminder.
        await this.prisma.booking
          .update({ where: { id: b.id }, data: { reminderSent: false } })
          .catch(() => {});
      }
    }

    // Catch-up: bookings starting within 30 minutes, regardless of
    // reminderSent, unless this instance already reminded them.
    const imminent = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.confirmed,
        date: today,
        startMinutes: { gt: nowMin, lte: nowMin + 30 },
      },
      include: { venue: { select: { name: true } } },
    });
    for (const b of imminent) {
      if (!b.userId) continue;
      if (this.recentlyReminded(this.bookingRemindedAt, b.id)) continue;
      const hh = String(Math.floor(b.startMinutes / 60)).padStart(2, '0');
      const mm = String(b.startMinutes % 60).padStart(2, '0');
      await this.notifications.notifyBookingReminder(b.userId, b.venue.name, `${hh}:${mm}`).catch(() => {});
      this.bookingRemindedAt.set(b.id, Date.now());
      await this.prisma.booking
        .update({ where: { id: b.id }, data: { reminderSent: true } })
        .catch(() => {});
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
      const claimed = await this.prisma.gamePost.updateMany({
        where: { id: g.id, reminderSent: false },
        data: { reminderSent: true },
      });
      if (claimed.count === 0) continue;
      try {
        await this.remindGame(g);
        this.gameRemindedAt.set(g.id, Date.now());
      } catch {
        await this.prisma.gamePost
          .update({ where: { id: g.id }, data: { reminderSent: false } })
          .catch(() => {});
      }
    }

    // Game catch-up: same last-30-minutes rule as bookings.
    const imminentGames = await this.prisma.gamePost.findMany({
      where: {
        status: { in: ['open', 'full'] },
        date: today,
        startMinutes: { gt: nowMin, lte: nowMin + 30 },
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
    for (const g of imminentGames) {
      if (this.recentlyReminded(this.gameRemindedAt, g.id)) continue;
      await this.remindGame(g).catch(() => {});
      this.gameRemindedAt.set(g.id, Date.now());
      await this.prisma.gamePost
        .update({ where: { id: g.id }, data: { reminderSent: true } })
        .catch(() => {});
    }
  }

  /** One game reminder to host + joined squad, with the per-player share. */
  private async remindGame(g: {
    creatorId: string;
    sport: string;
    city: string;
    startMinutes: number;
    squadSize: number | null;
    playersNeeded: number;
    participants: { userId: string | null }[];
    venue: { name: string } | null;
    booking: { totalPrice: unknown } | null;
  }) {
    const hh = String(Math.floor(g.startMinutes / 60)).padStart(2, '0');
    const mm = String(g.startMinutes % 60).padStart(2, '0');
    // Joiners owe their share at the venue — say so while there's
    // still time to bring cash. The host collects; they get no line.
    // totalPrice is already net of any discount.
    let pricePerPlayer: number | null = null;
    if (g.booking) {
      const fee = Math.max(0, Number(g.booking.totalPrice));
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
  }

  /**
   * Game posts whose match start has passed have done their job. Close
   * them (never delete) so the status stays truthful everywhere — board
   * filters, direct links, host history and admin views — instead of
   * lingering as `open`/`full` forever. The board's own time filter
   * already hides them between sweeps.
   */
  @Cron('*/15 * * * *', PKT)
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
  @Cron('30 0 * * *', PKT)
  async billingSweep() {
    const result = await this.plans.sweepBilling();
    if (result.paused > 0 || result.resumed > 0) {
      this.logger.log(
        `Billing sweep: ${result.checked} venues, ${result.paused} paused, ${result.resumed} resumed`,
      );
    }
  }

  @Cron('0 3 * * *', PKT)
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
  @Cron('0 2 * * *', PKT)
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
