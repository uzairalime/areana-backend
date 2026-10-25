import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

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
    await this.transporter.sendMail({
      from: this.config.get('smtp.from'),
      to,
      subject,
      text,
    });
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
