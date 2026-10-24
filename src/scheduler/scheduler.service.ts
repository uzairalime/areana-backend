import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma';
import { minutesSinceMidnight, startOfToday } from '../common/date.util';
import { parseSettingFloat } from '../common/settings.util';
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
  // id / game id → epoch ms), a second dedupe layer behind the
  // persisted reminderSent flag. Entries are pruned past 3 hours —
  // the prune window must exceed the 120-minute reminder gap, or a
  // booking reminded at T−120 loses its marker before T−30 and gets
  // pinged twice (the old 60-minute prune did exactly that).
  private bookingRemindedAt = new Map<string, number>();
  private gameRemindedAt = new Map<string, number>();

  private recentlyReminded(map: Map<string, number>, id: string): boolean {
    const now = Date.now();
    for (const [k, t] of map) {
      if (now - t > 180 * 60_000) map.delete(k);
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
    // Validated like graceDays: a garbage value used to parse to NaN,
    // making expiryAt NaN so pending bookings never expired. Zero is
    // not a sane window either — it falls back to 2h like garbage.
    const parsedHours = parseSettingFloat(await this.setting('pendingExpiryHours', '2'), 2);
    const hours = parsedHours > 0 ? parsedHours : 2;
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
   * opened, or created while the scheduler was down. Every pass claims
   * its rows atomically (updateMany where reminderSent=false AND the
   * status still qualifies): two instances racing the same row get
   * exactly one claim, a just-cancelled booking/game is never
   * reminded, and the persisted flag — not just the in-process map —
   * is what prevents a restart from re-pinging the window. A push
   * failure releases the claim so a later run retries.
   */
  @Cron('*/30 * * * *', PKT)
  async sendReminders() {
    const today = startOfToday();
    const nowMin = minutesSinceMidnight();
    const upcoming = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.confirmed,
        reminderSent: false,
        OR: this.reminderWindows(today, nowMin, 120, 'gt'),
      },
      include: { venue: { select: { name: true } } },
    });
    for (const b of upcoming) {
      if (!b.userId) continue;
      // Atomic claim: the reminderSent + status conditions inside the
      // UPDATE mean a second instance claiming the same row gets
      // count 0 and skips — and a booking cancelled between the query
      // and this write is never reminded. The booking is reminded
      // exactly once from here.
      const claimed = await this.prisma.booking.updateMany({
        where: { id: b.id, reminderSent: false, status: BookingStatus.confirmed },
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

    // Catch-up: bookings starting within 30 minutes that the normal
    // pass missed (accepted after the 2h window opened, or created
    // while the scheduler was down). It now respects the persisted
    // reminderSent flag and claims like the normal pass: the old
    // version ignored the flag and deduped only in-process, so a
    // booking reminded at T−120 was re-pinged at T−30 (the 60-minute
    // in-memory prune vs the 120-minute gap) and every restart
    // re-pinged everything in the window. The gte (not gt) lower bound
    // means a booking accepted at 17:59 for 18:00 still gets pinged.
    const imminent = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.confirmed,
        reminderSent: false,
        OR: this.reminderWindows(today, nowMin, 30, 'gte'),
      },
      include: { venue: { select: { name: true } } },
    });
    for (const b of imminent) {
      if (!b.userId) continue;
      if (this.recentlyReminded(this.bookingRemindedAt, b.id)) continue;
      const claimed = await this.prisma.booking.updateMany({
        where: { id: b.id, reminderSent: false, status: BookingStatus.confirmed },
        data: { reminderSent: true },
      });
      if (claimed.count === 0) continue;
      const hh = String(Math.floor(b.startMinutes / 60)).padStart(2, '0');
      const mm = String(b.startMinutes % 60).padStart(2, '0');
      try {
        await this.notifications.notifyBookingReminder(b.userId, b.venue.name, `${hh}:${mm}`);
        this.bookingRemindedAt.set(b.id, Date.now());
      } catch {
        await this.prisma.booking
          .update({ where: { id: b.id }, data: { reminderSent: false } })
          .catch(() => {});
      }
    }

    // Game posts starting within 2 hours: remind the host and everyone
    // who joined — board games previously had no reminder at all.
    const games = await this.prisma.gamePost.findMany({
      where: {
        status: { in: ['open', 'full'] },
        reminderSent: false,
        OR: this.reminderWindows(today, nowMin, 120, 'gt'),
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
        where: { id: g.id, reminderSent: false, status: { in: ['open', 'full'] } },
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

    // Game catch-up: same last-30-minutes rule as bookings, same
    // claim-before-notify discipline.
    const imminentGames = await this.prisma.gamePost.findMany({
      where: {
        status: { in: ['open', 'full'] },
        reminderSent: false,
        OR: this.reminderWindows(today, nowMin, 30, 'gte'),
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
      const claimed = await this.prisma.gamePost.updateMany({
        where: { id: g.id, reminderSent: false, status: { in: ['open', 'full'] } },
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
  }

  /**
   * Reminder window clauses for a run at `nowMin` (minutes since
   * midnight) with a `horizon`-minute lookahead. The second clause is
   * the early-morning spill: games starting 00:00–02:00 used to never
   * get a 2h reminder (a 00:00 game got none at all), because the
   * query filtered `date: today`. When the window crosses midnight,
   * tomorrow's early bookings are included too — their 2h reminder
   * fires on the pre-midnight evening run.
   */
  private reminderWindows(
    today: Date,
    nowMin: number,
    horizon: number,
    op: 'gt' | 'gte',
  ) {
    const todayClause = {
      date: today,
      startMinutes: { [op]: nowMin, lte: nowMin + horizon },
    };
    if (nowMin + horizon <= 1440) return [todayClause];
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return [
      todayClause,
      { date: tomorrow, startMinutes: { lte: nowMin + horizon - 1440 } },
    ];
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
      // Floored share, matching priceView: the host absorbs the
      // remainder so the squad collects exactly the fee.
      if (squad > 0) pricePerPlayer = Math.floor(fee / squad);
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
    // Close on the game's END, not its start or play date: a
    // booking-linked post for an overnight game (Fri 23:00–01:00)
    // used to close at the 00:00 tick, before its game had ended.
    // Booking-linked posts use the booking's slot end (slotEnded
    // handles the midnight rollover); curated posts carry no end time,
    // so they still close once their start has passed.
    const posts = await this.prisma.gamePost.findMany({
      where: { status: { in: ['open', 'full'] } },
      select: {
        id: true,
        date: true,
        startMinutes: true,
        booking: { select: { date: true, endMinutes: true } },
      },
    });
    const now = new Date();
    const expiredIds = posts
      .filter((p) => {
        if (p.booking) return this.bookings.slotEnded(p.booking, now);
        const start = new Date(p.date.getFullYear(), p.date.getMonth(), p.date.getDate());
        start.setMinutes(p.startMinutes);
        return start <= now;
      })
      .map((p) => p.id);
    if (expiredIds.length === 0) return;
    const res = await this.prisma.gamePost.updateMany({
      where: { id: { in: expiredIds }, status: { in: ['open', 'full'] } },
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

  // Single-flight flag for the nightly job: overlapping runs (a
  // restart near the 02:00 tick, a second instance) used to
  // double-mint referral rewards and resurrect bookings cancelled
  // after the snapshot. The flag stops same-process overlap; the
  // status-conditioned claims below stop cross-process overlap too.
  private nightlyRunning = false;

  /** Nightly: complete past bookings, pay out referral rewards, recompute badges. */
  @Cron('0 2 * * *', PKT)
  async nightly() {
    if (this.nightlyRunning) {
      this.logger.log('Nightly already running — skipping overlapping run');
      return;
    }
    this.nightlyRunning = true;
    try {
      await this.runNightly();
    } finally {
      this.nightlyRunning = false;
    }
  }

  private async runNightly() {
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
      // Claim the completion: a booking cancelled after the snapshot
      // (a late owner cancel, a player cancel) must not be resurrected
      // to completed by this unconditional write. The reschedule
      // rejection below is likewise scoped to bookings that actually
      // completed here.
      await this.prisma.booking.updateMany({
        where: { id: { in: doneIds }, status: BookingStatus.confirmed },
        data: { status: BookingStatus.completed },
      });
      await this.prisma.rescheduleRequest.updateMany({
        where: {
          bookingId: { in: doneIds },
          status: 'pending',
          booking: { status: BookingStatus.completed },
        },
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
