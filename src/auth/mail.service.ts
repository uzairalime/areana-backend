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
      auth: this.config.get('smtp.user')
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
