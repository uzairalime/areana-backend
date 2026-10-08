import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma';
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

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private mail: MailService,
  ) {
    if (this.config.get('fcm.enabled')) {
      try {
        // Lazy require so the app boots without firebase-admin configured.
        const admin = require('firebase-admin');
        const sa = this.config.get('fcm.serviceAccount');
        admin.initializeApp({
          credential: sa
            ? admin.credential.cert(JSON.parse(sa))
            : admin.credential.applicationDefault(),
        });
        this.fcm = admin.messaging();
        this.logger.log('FCM push enabled');
      } catch (e) {
        this.logger.warn(`FCM init failed, push will log-only: ${(e as Error).message}`);
      }
    }
  }

  // --- primitives ---
  async pushToUser(userId: string, msg: PushMessage): Promise<void> {
    const tokens = await this.prisma.deviceToken.findMany({ where: { userId } });
    if (tokens.length === 0) return;
    await this.pushToTokens(tokens.map((t) => t.token), msg);
  }

  async broadcastPush(msg: PushMessage, city?: string): Promise<number> {
    const tokens = await this.prisma.deviceToken.findMany({
      where: city ? { user: { city } } : {},
    });
    await this.pushToTokens(tokens.map((t) => t.token), msg);
    return tokens.length;
  }

  private async pushToTokens(tokens: string[], msg: PushMessage): Promise<void> {
    if (tokens.length === 0) return;
    if (!this.fcm) {
      this.logger.log(`[push:log-only] to ${tokens.length} tokens: ${msg.title} — ${msg.body}`);
      return;
    }
    try {
      const res = await this.fcm.sendEachForMulticast({
        tokens,
        notification: { title: msg.title, body: msg.body },
        data: msg.data ?? {},
      });
      // Drop dead tokens.
      const dead: string[] = [];
      res.responses.forEach((r: any, i: number) => {
        if (!r.success && /not-registered|invalid-registration/i.test(r.error?.code ?? '')) {
          dead.push(tokens[i]);
        }
      });
      if (dead.length > 0) {
        await this.prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
      }
    } catch (e) {
      this.logger.warn(`FCM send failed: ${(e as Error).message}`);
    }
  }

  // --- booking events ---
  async notifyOwnerNewBooking(ownerEmail: string, venueName: string, summary: string) {
    await this.mail.sendMail(
      ownerEmail,
      `New booking request — ${venueName}`,
      `A new booking request needs your approval:\n\n${summary}\n\nOpen your Areana panel to accept or reject it.`,
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

  async notifyGameJoin(creatorId: string, playerName: string, sport: string) {
    await this.pushToUser(creatorId, {
      title: 'Someone joined your game',
      body: `${playerName} joined your ${sport} game.`,
      data: { type: 'game_join' },
    });
  }
}
