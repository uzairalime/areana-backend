import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { PrismaService } from '../common/prisma';
import { MailService } from './mail.service';
import { ReferralsService } from '../promos/referrals.service';
import {
  OwnerRegisterDto,
  RefreshDto,
  RequestOtpDto,
  StaffLoginDto,
  VerifyOtpDto,
} from './dto';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 5;
const OTP_IP_MAX_PER_HOUR = 30;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function randomCode(prefix: string): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${s}`;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private mail: MailService,
    private referrals: ReferralsService,
  ) {}

  // --- player: passwordless email OTP ---
  async requestOtp(dto: RequestOtpDto, ip?: string) {
    const email = dto.email.toLowerCase().trim();

    const recent = await this.prisma.otpCode.count({
      where: { email, createdAt: { gte: new Date(Date.now() - 3600_000) } },
    });
    if (recent >= OTP_MAX_PER_HOUR) {
      throw new HttpException(
        'Too many codes requested. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // Per-IP cap as well: the per-email cap alone lets one machine spray
    // codes across many addresses.
    if (ip) {
      const recentIp = await this.prisma.otpCode.count({
        where: { ip, createdAt: { gte: new Date(Date.now() - 3600_000) } },
      });
      if (recentIp >= OTP_IP_MAX_PER_HOUR) {
        throw new HttpException(
          'Too many codes requested. Try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.prisma.otpCode.create({
      data: {
        email,
        codeHash: await bcrypt.hash(code, 10),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
        ip: ip ?? undefined,
      },
    });
    await this.mail.sendOtp(email, code);
    return { message: 'Login code sent to your email' };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const email = dto.email.toLowerCase().trim();

    const record = await this.prisma.otpCode.findFirst({
      where: { email, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!record || record.attempts >= OTP_MAX_ATTEMPTS) {
      throw new UnauthorizedException('Code invalid or expired');
    }
    const ok = await bcrypt.compare(dto.code, record.codeHash);
    if (!ok) {
      await this.prisma.otpCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Code invalid or expired');
    }
    // NOTE: the code is NOT consumed yet. A first-time player still has to
    // complete signup (name/phone) with this same code in a follow-up call —
    // consuming here would burn the code and make that call fail with 401.
    // It is consumed below, only once every check has passed.

    const playerRole = await this.prisma.role.findUniqueOrThrow({ where: { name: 'player' } });

    let welcomePromoCode: string | null = null;
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      // First verification = signup: profile details required.
      if (!dto.name || !dto.phone) {
        throw new BadRequestException('Name and phone are required to create your account');
      }
      user = await this.prisma.user.create({
        data: {
          email,
          name: dto.name,
          phone: dto.phone,
          city: dto.city,
          roleId: playerRole.id,
          referralCode: randomCode('AREANA'),
          status: UserStatus.active,
        },
      });
      welcomePromoCode = dto.referralCode
        ? ((await this.referrals.handleSignupReferral(user.id, dto.referralCode))?.promo.code ?? null)
        : null;
    }
    if (user.status !== UserStatus.active) {
      throw new ForbiddenException('This account is not active');
    }
    // All checks passed — now consume the code so it cannot be replayed.
    await this.prisma.otpCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
    return { ...(await this.issueTokens(user)), welcomePromoCode };
  }

  async refresh(dto: RefreshDto) {
    let payload: { sub: string; sid?: string };
    try {
      payload = await this.jwt.verifyAsync(dto.refreshToken, {
        secret: this.config.get('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== UserStatus.active) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    // Session-backed rotation: the presented token must be the live,
    // unrevoked session token. Anything else (an old rotated token, a
    // logged-out one) is treated as reuse — kill every session.
    const session = payload.sid
      ? await this.prisma.refreshSession.findUnique({ where: { id: payload.sid } })
      : null;
    if (
      !session ||
      session.userId !== user.id ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.tokenHash !== hashToken(dto.refreshToken)
    ) {
      if (session) {
        await this.prisma.refreshSession.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      throw new UnauthorizedException('Invalid refresh token');
    }
    await this.prisma.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    return this.issueTokens(user);
  }

  /** Revokes the session behind a refresh token (best-effort, idempotent). */
  /**
   * Password rotation for panel accounts: verify the current password,
   * store the new hash, and revoke EVERY refresh session — a changed
   * password must log the account out everywhere, including here.
   */
  async changePassword(
    userId: string,
    dto: { currentPassword: string; newPassword: string },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash) {
      throw new BadRequestException(
        'This account signs in with email codes — there is no password to change',
      );
    }
    const ok = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!ok) throw new BadRequestException('Current password is incorrect');
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, 10) },
    });
    await this.prisma.refreshSession.deleteMany({ where: { userId } });
    return { message: 'Password changed — please sign in again' };
  }

  async logout(refreshToken: string) {
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; sid?: string }>(
        refreshToken,
        { secret: this.config.get('jwt.refreshSecret'), ignoreExpiration: true },
      );
      if (payload.sid) {
        await this.prisma.refreshSession.updateMany({
          where: { id: payload.sid, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    } catch {
      /* an unverifiable token has no live session to revoke */
    }
    return { ok: true };
  }

  // --- owner self-registration (needs super admin approval) ---
  async ownerRegister(dto: OwnerRegisterDto) {
    const email = dto.email.toLowerCase().trim();
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException('Email already registered');

    const ownerRole = await this.prisma.role.findUniqueOrThrow({ where: { name: 'owner' } });
    const user = await this.prisma.user.create({
      data: {
        email,
        name: dto.name,
        phone: dto.phone,
        passwordHash: await bcrypt.hash(dto.password, 10),
        roleId: ownerRole.id,
        status: UserStatus.pending,
      },
    });
    return { message: 'Owner account created. Waiting for admin approval.', userId: user.id };
  }

  // --- staff login: owner / staff / super_admin (web panels) ---
  async staffLogin(dto: StaffLoginDto) {
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { role: true },
    });
    const valid = user?.passwordHash && (await bcrypt.compare(dto.password, user.passwordHash));
    if (!valid) throw new UnauthorizedException('Invalid credentials');
    if (user.role.name === 'player') {
      throw new ForbiddenException('Players log in from the mobile app');
    }
    if (user.status !== UserStatus.active) {
      throw new ForbiddenException('Account is pending approval or suspended');
    }
    return this.issueTokens(user);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (!user) throw new UnauthorizedException('User not found');
    const { passwordHash: _ph, ...safe } = user;
    return safe;
  }

  private async issueTokens(user: User) {
    const role = await this.prisma.role.findUniqueOrThrow({ where: { id: user.roleId } });
    const payload = { sub: user.id, email: user.email, roleId: user.roleId, roleName: role.name };
    const refreshTtl: number = this.config.get('jwt.refreshTtl');
    const session = await this.prisma.refreshSession.create({
      data: {
        userId: user.id,
        tokenHash: 'pending',
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
    });
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.get('jwt.accessSecret'),
        expiresIn: this.config.get('jwt.accessTtl'),
      }),
      this.jwt.signAsync(
        { ...payload, sid: session.id },
        {
          secret: this.config.get('jwt.refreshSecret'),
          expiresIn: refreshTtl,
        },
      ),
    ]);
    await this.prisma.refreshSession.update({
      where: { id: session.id },
      data: { tokenHash: hashToken(refreshToken) },
    });
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: role.name,
        permissions: role.permissions,
      },
    };
  }
}
