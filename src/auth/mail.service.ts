import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * Round 5, D5-S34: a slow-but-alive SMTP server can accept DATA and
 * then stall past the socket timeout — nodemailer aborts, the
 * send-first OTP path persists nothing, but the player still receives
 * a code with no stored row and gets "Code invalid" for the exact code
 * just emailed. The expiry clock itself is already aligned (the OTP
 * row is created AFTER a successful send, so expiresAt runs from
 * send completion, not request start); what was missing was a
 * distinguishable error for the timeout case, so the caller can tell
 * the player the previous code still works instead of a generic
 * failure. Mapping this to a dedicated HTTP status lives in the OTP
 * endpoint (auth.service) — this class is the distinguishable part.
 */
export class MailDeliveryDelayedError extends Error {
  constructor() {
    super(
      'Mail delivery was delayed and could not be confirmed — if you received a code, it may not be verifiable yet; your previous code still works, or request a new one shortly.',
    );
    this.name = 'MailDeliveryDelayedError';
  }
}

// Nodemailer error codes for a send that timed out mid-flight (as
// opposed to a refused connection or bad credentials, which fail
// before any mail is queued).
const DELAYED_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET']);

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get('smtp.host'),
      port: this.config.get('smtp.port'),
      // Round 4, P-S7: nodemailer defaults are connection timeout 2
      // min and socket inactivity timeout 1 HOUR — a firewall DROP
      // (not REJECT) to the SMTP host used to hang OTP requests for up
      // to an hour and hang booking responses after the booking had
      // already committed. Short explicit timeouts instead.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      // Round 4, SMTP trivial: an SMTP_USER with no password used to
      // build `auth: { user, pass: undefined }` — an authenticated
      // attempt with an undefined password — instead of no-auth.
      // Auth is only sent when BOTH user and password are set.
      auth:
        this.config.get('smtp.user') && this.config.get('smtp.pass')
          ? { user: this.config.get('smtp.user'), pass: this.config.get('smtp.pass') }
          : undefined,
    });
  }

  async sendMail(to: string, subject: string, text: string): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.config.get('smtp.from'),
        to,
        subject,
        text,
      });
    } catch (e) {
      // A timeout here does not prove the mail was NOT sent — a
      // greylisting/AV-scanning server may have queued it while the
      // socket stalled. Surface that distinctly (D5-S34) instead of
      // a generic failure the caller reports as "not sent".
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code && DELAYED_CODES.has(code)) throw new MailDeliveryDelayedError();
      throw e;
    }
  }

  async sendOtp(email: string, code: string): Promise<void> {
    // In dev the code is also logged — open Mailpit at :8025 or read the console.
    if (!this.config.get('isProd')) {
      this.logger.log(`[dev] OTP for ${email}: ${code}`);
    }
    await this.sendMail(
      email,
      'Your Areana login code',
      `Your Areana login code is ${code}. It expires in 10 minutes.`,
    );
  }
}
