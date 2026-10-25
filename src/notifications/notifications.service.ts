import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma';
import { cursorPage, keysetWhere, pageLimit } from '../common/pagination';
import { MailService } from '../auth/mail.service';

interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Fan-out for all user-facing notifications.
 * Email always works (SMTP). Push uses FCM when FCM_ENABLED=true with a
 * service account; otherwise it logs (dev) so flows stay testable.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private fcm: any = null;
  private fcmError: string | null = null;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private mail: MailService,
  ) {
    if (this.config.get('fcm.enabled')) {
      // Round 4, P-S8: FCM init used to fail silently (warn + null),
      // leaving every reminder, decision, billing and broadcast push
      // log-only forever while broadcasts still recorded full
      // `targeted` counts. When FCM is explicitly enabled, a bad
      // config is a deploy error, not a warning — boot hard-fails so
      // it is fixed instead of discovered from missing pushes.
      try {
        // Lazy require so the app boots without firebase-admin configured.
        const admin = require('firebase-admin');
        const sa = this.config.get('fcm.serviceAccount');
        let credential;
        if (sa) {
          let parsed: any;
          try {
            parsed = JSON.parse(sa);
          } catch {
            throw new Error('FCM_SERVICE_ACCOUNT is not valid JSON');
          }
          if (!parsed || typeof parsed !== 'object' || !parsed.project_id) {
            throw new Error('FCM_SERVICE_ACCOUNT JSON is missing project_id');
          }
          credential = admin.credential.cert(parsed);
        } else {
          credential = admin.credential.applicationDefault();
        }
        admin.initializeApp({ credential });
        this.fcm = admin.messaging();
        this.logger.log('FCM push enabled');
      } catch (e) {
        this.fcmError = (e as Error).message;
        throw new Error(`[BOOT] FCM_ENABLED=true but FCM init failed: ${this.fcmError}`);
      }
    }
  }

  /** Health endpoint: never claim push is fine when it is not. */
  fcmStatus(): { enabled: boolean; configured: boolean; error: string | null } {
    return {
      enabled: !!this.config.get('fcm.enabled'),
      configured: !!this.fcm,
      error: this.fcmError,
    };
  }

  // --- primitives ---
  async pushToUser(userId: string, msg: PushMessage): Promise<void> {
    // The inbox copy is written FIRST and unconditionally — a player
    // with no registered device (web-only) still gets their history.
    try {
      await this.prisma.notification.create({
        data: {
          userId,
          type: msg.data?.type ?? 'general',
          title: msg.title,
          body: msg.body,
          data: msg.data ?? undefined,
        },
      });
    } catch (e) {
      this.logger.warn(`Inbox write failed for ${userId}: ${(e as Error).message}`);
    }
    const tokens = await this.prisma.deviceToken.findMany({ where: { userId } });
    if (tokens.length === 0) return;
    await this.pushToTokens(tokens.map((t) => t.token), msg);
  }

  // --- inbox -------------------------------------------------------------
  async listMine(userId: string, cursor?: string, rawLimit?: number) {
    const limit = pageLimit(rawLimit, 30);
    const rows = await this.prisma.notification.findMany({
      where: { userId, ...keysetWhere(cursor, 'createdAt', 'desc') },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return cursorPage(rows, limit);
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    return { count };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  async markRead(userId: string, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Round 4, P-B1 + P-S10: two broadcast lies fixed here.
   * (1) sendEachForMulticast THROWS above 500 tokens (FCM_MAX_BATCH_SIZE)
   * — one unchunked call used to throw, get swallowed by a log warning,
   * and history still recorded the full `targeted` count while ZERO
   * phones received anything. Tokens are now chunked at 500 and each
   * batch's success/failure counted; the caller records the ACTUAL
   * delivered count, not the attempted one.
   * (2) The send path used to filter only by exact-match city — no
   * role, no status — while the audience count used active + player
   * role + case-insensitive city. Owners/staff in the city received
   * "player" broadcasts, and players stored as "lahore" were counted
   * but never sent to. The send predicate is now exactly the audience
   * predicate.
   */
  async broadcastPush(
    msg: PushMessage,
    city?: string,
  ): Promise<{ targeted: number; delivered: number; failed: number }> {
    const userWhere: any = {
      status: 'active',
      role: { name: 'player' },
      ...(city ? { city: { equals: city, mode: 'insensitive' } } : {}),
    };
    const tokens = await this.prisma.deviceToken.findMany({
      where: { user: userWhere },
    });
    const result = await this.pushToTokens(tokens.map((t) => t.token), msg);
    return { targeted: tokens.length, ...result };
  }

  private async pushToTokens(
    tokens: string[],
    msg: PushMessage,
  ): Promise<{ delivered: number; failed: number }> {
    if (tokens.length === 0) return { delivered: 0, failed: 0 };
    if (!this.fcm) {
      this.logger.log(`[push:log-only] to ${tokens.length} tokens: ${msg.title} — ${msg.body}`);
      return { delivered: 0, failed: 0 };
    }
    // Firebase caps a multicast batch at 500 tokens and THROWS above
    // it — chunk, and never let one batch's failure hide the rest.
    const BATCH = 500;
    let delivered = 0;
    let failed = 0;
    for (let i = 0; i < tokens.length; i += BATCH) {
      const batch = tokens.slice(i, i + BATCH);
      try {
        const res = await this.fcm.sendEachForMulticast({
          tokens: batch,
          notification: { title: msg.title, body: msg.body },
          data: msg.data ?? {},
        });
        // Drop dead tokens.
        const dead: string[] = [];
        res.responses.forEach((r: any, j: number) => {
          if (r.success) delivered++;
          else {
            failed++;
            if (/not-registered|invalid-registration/i.test(r.error?.code ?? '')) {
              dead.push(batch[j]);
            }
          }
        });
        if (dead.length > 0) {
          await this.prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
        }
      } catch (e) {
        // A failed batch counts as failed, loudly — never a swallowed
        // warning with a success recorded elsewhere.
        failed += batch.length;
        this.logger.error(`FCM batch send failed (${batch.length} tokens): ${(e as Error).message}`);
      }
    }
    return { delivered, failed };
  }

  // --- booking events ---
  /**
   * Round 4, P-S6 + P-S7: owner emails used to be awaited with an
   * empty `.catch(() => {})` — a transient SMTP blip lost the email
   * with no log, no retry, no audit row, and (worse) the await hung
   * the booking response after the booking had already committed.
   * Owner mail is now fire-and-forget with one retry and loud logs:
   * this helper never throws, so callers must NOT await it — the
   * booking response returns immediately and the email follows (or
   * its failure is at least visible in the log with full context).
   */
  private async sendOwnerMail(
    to: string,
    subject: string,
    text: string,
    context: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.mail.sendMail(to, subject, text);
        return;
      } catch (e) {
        this.logger.error(
          `Owner email failed (attempt ${attempt + 1}/2, ${context}): ${(e as Error).message}`,
        );
        if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    this.logger.error(`Owner email LOST after retry (${context}) — owner was not notified.`);
  }

  async notifyOwnerNewBooking(ownerEmail: string, venueName: string, summary: string) {
    await this.sendOwnerMail(
      ownerEmail,
      `New booking request — ${venueName}`,
      `A new booking request needs your approval:\n\n${summary}\n\nOpen your Areana panel to accept or reject it.`,
      `new-booking ${venueName}`,
    );
  }

  /** Auto-accept venues: the booking is already confirmed, so the owner
   * email must not read like an approval request (Round 4: confirmed
   * bookings used to notify nobody, because the create path only
   * emailed for pending requests). */
  async notifyOwnerConfirmedBooking(ownerEmail: string, venueName: string, summary: string) {
    await this.sendOwnerMail(
      ownerEmail,
      `New booking confirmed — ${venueName}`,
      `A booking at your arena was confirmed automatically (auto-accept):\n\n${summary}\n\nOpen your Areana panel to view it.`,
      `confirmed-booking ${venueName}`,
    );
  }

  /** Player-cancelled bookings: the owner is told, mirroring the
   * owner-cancel path that tells the player (Round 4: player cancels
   * used to notify nobody). */
  async notifyOwnerCancelledBooking(ownerEmail: string, venueName: string, summary: string) {
    await this.sendOwnerMail(
      ownerEmail,
      `Booking cancelled — ${venueName}`,
      `A player cancelled their booking:\n\n${summary}\n\nOpen your Areana panel to view your bookings.`,
      `cancelled-booking ${venueName}`,
    );
  }

  async notifyPlayerDecision(userId: string, accepted: boolean, venueName: string, when: string, reason?: string) {
    const title = accepted ? 'Booking confirmed' : 'Booking not approved';
    const body = accepted
      ? `Your slot at ${venueName} (${when}) is confirmed. See you there!`
      : `Your request at ${venueName} (${when}) was not approved.${reason ? ` Reason: ${reason}` : ''}`;
    await this.pushToUser(userId, { title, body, data: { type: 'booking_decision' } });
  }

  async notifyBookingReminder(userId: string, venueName: string, when: string) {
    await this.pushToUser(userId, {
      title: 'Upcoming game',
      body: `Reminder: your slot at ${venueName} starts at ${when}.`,
      data: { type: 'booking_reminder' },
    });
  }

  async notifyRescheduleDecision(userId: string, accepted: boolean, venueName: string) {
    await this.pushToUser(userId, {
      title: accepted ? 'Reschedule approved' : 'Reschedule declined',
      body: accepted
        ? `Your booking at ${venueName} has been moved as requested.`
        : `Your reschedule request at ${venueName} was declined. Your original slot still stands.`,
      data: { type: 'reschedule_decision' },
    });
  }

  async notifyGameJoin(creatorId: string, playerName: string, sport: string, pricePerPlayer?: number | null) {
    await this.pushToUser(creatorId, {
      title: 'New join request',
      body:
        `${playerName} asked to join your ${sport} game — accept or decline it from the Games board.` +
        (pricePerPlayer
          ? ` Their share is Rs ${pricePerPlayer}, paid to you at the venue.`
          : ''),
      data: { type: 'game_join_request' },
    });
  }

  /**
   * Round 5, R5-5 + R5-17: push + email to a PLAYER (review replies,
   * share-participant notices, game-post leave notices). pushToUser
   * writes the inbox copy + FCM push; the email reuses the
   * fire-and-forget-with-one-retry helper the owner mails use, so a
   * mail failure is logged, never thrown — callers still .catch() the
   * push half as elsewhere. Deleted/anonymized accounts have no
   * deliverable address (deleted+<id>@areana.invalid) and are skipped.
   */
  async notifyPlayerEvent(
    userId: string,
    msg: PushMessage,
    emailSubject: string,
  ): Promise<void> {
    await this.pushToUser(userId, msg).catch(() => {});
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      if (user?.email && !user.email.endsWith('@areana.invalid')) {
        await this.sendOwnerMail(user.email, emailSubject, msg.body, `player-event ${msg.data?.type ?? 'general'}`);
      }
    } catch (e) {
      // sendOwnerMail itself never throws; this guards only the
      // email lookup above. A notice failure must never fail the
      // booking/review/game operation that triggered it.
      this.logger.warn(`Player email lookup failed for ${userId}: ${(e as Error).message}`);
    }
  }
}
