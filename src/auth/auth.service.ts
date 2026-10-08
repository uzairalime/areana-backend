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
  async requestOtp(dto: RequestOtpDto) {
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

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.prisma.otpCode.create({
      data: {
        email,
        codeHash: await bcrypt.hash(code, 10),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
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
    await this.prisma.otpCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });

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
    return { ...(await this.issueTokens(user)), welcomePromoCode };
  }

  async refresh(dto: RefreshDto) {
    let payload: { sub: string };
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
    return this.issueTokens(user);
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
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.get('jwt.accessSecret'),
        expiresIn: this.config.get('jwt.accessTtl'),
      }),
      this.jwt.signAsync(payload, {
        secret: this.config.get('jwt.refreshSecret'),
        expiresIn: this.config.get('jwt.refreshTtl'),
      }),
    ]);
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
