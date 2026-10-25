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
import { Prisma, Role, User, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { PrismaService } from '../common/prisma';
import { MailDeliveryDelayedError, MailService } from './mail.service';
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
// Round 5, P5-S7: grace window for a lost-response rotation replay.
// A refresh that rotated server-side but whose response was lost to a
// network drop looks exactly like token reuse on retry — the old
// scheme revoked EVERY session for it. Within this window after the
// rotation, a replay of the just-rotated token rotates AGAIN from the
// successor session instead of killing sessions. After the window, a
// replayed old token is treated as theft (revoke-all) as before.
// Logout revocations never carry a successor, so they never qualify.
const ROTATION_GRACE_MS = 120_000;
// Round 5, P5-S53 (session/JWT boundary): the session row is created
// BEFORE the JWT is signed, so the session expires a few milliseconds
// before the JWT does — a refresh landing exactly on the boundary
// used to 401 on a token that was still valid. The JWT is the
// authoritative expiry (an expired JWT never reaches the session
// check), so a small grace here only absorbs that creation-to-sign
// skew, it never extends a dead token's life.
const SESSION_EXPIRY_GRACE_MS = 5_000;

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

    // Round 4, P-B2: the old order was invalidate predecessors, then
    // create, then send (bare, unguarded). A failed send — the default
    // behaviour when prod SMTP is forgotten, since the config defaulted
    // to localhost:1025 — destroyed the previous working code AND
    // burned the hourly cap (the failed row still counted), leaving
    // the player locked out for up to an hour through no fault of
    // their own. New order: SEND FIRST, persist only on success. A
    // failed send persists nothing, so the previous code stays live
    // and the hourly count (which counts stored rows) is untouched.
    // The single-live-code invariant is preserved by invalidating
    // predecessors immediately after a successful send, before the new
    // row is created: verify always tests the NEWEST code but
    // increments ITS attempt counter on every wrong guess, so typing
    // an old code five times used to lock the current code the user
    // never mistyped.
    const code = String(Math.floor(100000 + Math.random() * 900000));
    // Round 5, D5-S34: a slow SMTP server can accept DATA then stall
    // past the socket timeout — nodemailer aborts, but the mail may
    // already be queued, so the player receives a code no row backs.
    // That is NOT a generic failure: surface a dedicated 503 stating
    // the previous code still works (nothing was invalidated below,
    // because the persist step never ran) and that a resend is safe.
    try {
      await this.mail.sendOtp(email, code);
    } catch (e) {
      if (e instanceof MailDeliveryDelayedError) {
        throw new HttpException(
          'Mail delivery was delayed and could not be confirmed — your previous code still works, or request a new one shortly.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw e;
    }
    // Round 5, P5-S52 + D5-S35: invalidate predecessors INSIDE the
    // same transaction as the create. The old sequence (invalidate,
    // then create, as separate statements) let two concurrent
    // requests interleave — B invalidates before A creates — and
    // leave two live codes, only the newest verifiable. The
    // transaction also re-checks both hourly caps, so concurrent
    // requests cannot overshoot the persisted cap either: a loser
    // aborts before invalidating anything, so its emailed code is
    // unpersisted but the previous code stays live (see the D5-S34
    // message above for the same shape). Send stays outside the
    // transaction (it cannot roll back); only the persist is atomic.
    const codeHash = await bcrypt.hash(code, 10);
    await this.prisma.$transaction(async (tx) => {
        const recent = await tx.otpCode.count({
          where: { email, createdAt: { gte: new Date(Date.now() - 3600_000) } },
        });
        if (recent >= OTP_MAX_PER_HOUR) {
          throw new HttpException(
            'Too many codes requested. Your previous code still works — try again later.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        if (ip) {
          const recentIp = await tx.otpCode.count({
            where: { ip, createdAt: { gte: new Date(Date.now() - 3600_000) } },
          });
          if (recentIp >= OTP_IP_MAX_PER_HOUR) {
            throw new HttpException(
              'Too many codes requested. Your previous code still works — try again later.',
              HttpStatus.TOO_MANY_REQUESTS,
            );
          }
        }
        await tx.otpCode.updateMany({
          where: { email, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        await tx.otpCode.create({
          data: {
            email,
            codeHash,
            expiresAt: new Date(Date.now() + OTP_TTL_MS),
            ip: ip ?? undefined,
          },
        });
      });
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

    const playerRole = await this.prisma.role.findFirstOrThrow({ where: { name: 'player', ownerId: null } });

    let welcomePromoCode: string | null = null;
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      // First verification = signup: profile details required.
      if (!dto.name || !dto.phone) {
        throw new BadRequestException('Name and phone are required to create your account');
      }
      // Double-submit race: two concurrent first verifications both
      // pass the findUnique above, then the loser's insert hits the
      // unique-email constraint. That must read as "account already
      // created — please sign in", never a raw 500 — and the winner's
      // code is already consumed by then, so the loser cannot retry
      // this code either way.
      try {
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
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ConflictException('Account already created — please sign in');
        }
        throw e;
      }
      welcomePromoCode = dto.referralCode
        ? ((await this.referrals.handleSignupReferral(user.id, dto.referralCode))?.promo.code ?? null)
        : null;
    }
    if (user.status !== UserStatus.active) {
      throw new ForbiddenException('This account is not active');
    }
    // All checks passed — now consume the code so it cannot be replayed.
    // Round 5, P5-S51: the consume is CONDITIONAL (id AND consumedAt
    // IS NULL). The old unconditional update re-set consumedAt on a
    // row a resend had already invalidated, so a verification in
    // flight during a resend issued tokens for the superseded code —
    // and the new code stayed live too. Zero rows claimed means the
    // code was superseded mid-flight: no tokens, ever.
    const consumed = await this.prisma.otpCode.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) {
      throw new UnauthorizedException('Code invalid or expired');
    }
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
    // unrevoked session token.
    const session = payload.sid
      ? await this.prisma.refreshSession.findUnique({ where: { id: payload.sid } })
      : null;
    const now = new Date();
    const presentedHash = hashToken(dto.refreshToken);
    const sessionNotExpired = (s: { expiresAt: Date }) =>
      s.expiresAt.getTime() + SESSION_EXPIRY_GRACE_MS > now.getTime();
    const isLive =
      !!session &&
      session.userId === user.id &&
      !session.revokedAt &&
      sessionNotExpired(session) &&
      session.tokenHash === presentedHash;
    if (isLive) {
      return this.rotateTokens(user, session.id);
    }
    // Lost-response replay (Round 5, P5-S7): the first refresh rotated
    // server-side but its response never reached the client, so the
    // client retries with the now-revoked old token. If that token
    // matches the revoked session, the session was revoked BY A
    // ROTATION (replacedById set — logouts never set it), the rotation
    // is within the grace window, and the successor session is still
    // live, this is a retry of the same rotation, not theft: rotate
    // again from the successor instead of revoking every session.
    if (
      session &&
      session.userId === user.id &&
      session.tokenHash === presentedHash &&
      session.revokedAt &&
      session.replacedById &&
      now.getTime() - session.revokedAt.getTime() <= ROTATION_GRACE_MS
    ) {
      const successor = await this.prisma.refreshSession.findUnique({
        where: { id: session.replacedById },
      });
      if (
        successor &&
        successor.userId === user.id &&
        !successor.revokedAt &&
        sessionNotExpired(successor)
      ) {
        return this.rotateTokens(user, successor.id);
      }
    }
    // Round 5, P5-S53: revoke-all fires ONLY on a genuine reuse
    // signal — the presented token's hash does not match the stored
    // hash for its session (a token that is not the session's current
    // token being replayed). An expired session, a logged-out session
    // (revoked, no successor), or an old rotated token replayed
    // outside the grace window gets a plain 401 and revokes nothing:
    // those are stale tokens, not theft evidence, and the old
    // revoke-everything path logged innocent users out of every
    // device for exactly those cases. ('pending' is excluded: a
    // session whose hash was never stored after signing has no
    // current token to mismatch against.)
    if (
      session &&
      session.userId === user.id &&
      session.tokenHash !== presentedHash &&
      session.tokenHash !== 'pending'
    ) {
      await this.prisma.refreshSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    throw new UnauthorizedException('Invalid refresh token');
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
    // Round 4, P-S9: password change promises "log the account out
    // everywhere" — device tokens are a push channel, not a session,
    // so they used to survive and keep delivering booking notices to
    // a device whose credentials were just rotated. Revoke them with
    // the sessions.
    await this.prisma.deviceToken.deleteMany({ where: { userId } });
    return { message: 'Password changed — please sign in again' };
  }

  async logout(refreshToken: string, deviceToken?: string) {
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
      // Round 4, P-S9: sign-out on a device also revokes that
      // device's push token (when the client passes it), so a
      // shared/sold device stops receiving booking notices.
      if (deviceToken) {
        await this.prisma.deviceToken.deleteMany({
          where: { token: deviceToken, userId: payload.sub },
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

    const ownerRole = await this.prisma.role.findFirstOrThrow({ where: { name: 'owner', ownerId: null } });
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

  // Round 5, D5-S36: the login response must carry the SAME
  // filtered permissions jwt.strategy applies per request — disabled
  // roles zeroed, cross-owner arena roles zeroed unless the holder
  // staffs one of that owner's venues. Returning raw
  // role.permissions here used to show panel buttons that every
  // subsequent request 403'd on.
  private async filteredPermissions(
    user: User,
    role: Pick<Role, 'isActive' | 'permissions' | 'ownerId'>,
  ): Promise<string[]> {
    let permissions = role.isActive ? role.permissions : [];
    if (role.ownerId && role.ownerId !== user.id) {
      const staffsOwnersVenue = await this.prisma.venueStaff.findFirst({
        where: { userId: user.id, venue: { ownerId: role.ownerId } },
      });
      if (!staffsOwnersVenue) permissions = [];
    }
    return permissions;
  }

  private async issueTokens(user: User) {
    const role = await this.prisma.role.findUniqueOrThrow({ where: { id: user.roleId } });
    const refreshTtl: number = this.config.get('jwt.refreshTtl');
    const session = await this.prisma.refreshSession.create({
      data: {
        userId: user.id,
        tokenHash: 'pending',
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
    });
    const { accessToken, refreshToken } = await this.signTokens(user, role.name, session.id);
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: role.name,
        permissions: await this.filteredPermissions(user, role),
      },
    };
  }

  /** Sign access + refresh tokens for an already-created session row, then store the refresh hash. */
  private async signTokens(user: User, roleName: string, sessionId: string) {
    const payload = { sub: user.id, email: user.email, roleId: user.roleId, roleName };
    const refreshTtl: number = this.config.get('jwt.refreshTtl');
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.get('jwt.accessSecret'),
        expiresIn: this.config.get('jwt.accessTtl'),
      }),
      this.jwt.signAsync(
        { ...payload, sid: sessionId },
        {
          secret: this.config.get('jwt.refreshSecret'),
          expiresIn: refreshTtl,
        },
      ),
    ]);
    await this.prisma.refreshSession.update({
      where: { id: sessionId },
      data: { tokenHash: hashToken(refreshToken) },
    });
    return { accessToken, refreshToken };
  }

  /**
   * Rotate a session: create the successor and revoke the predecessor
   * WITH the link (replacedById) in ONE transaction, then sign. The
   * link is what lets a lost-response retry prove it is a retry of
   * this exact rotation (Round 5, P5-S7) instead of theft.
   */
  private async rotateTokens(user: User, fromSessionId: string) {
    const role = await this.prisma.role.findUniqueOrThrow({ where: { id: user.roleId } });
    const refreshTtl: number = this.config.get('jwt.refreshTtl');
    const session = await this.prisma.$transaction(async (tx) => {
      const ns = await tx.refreshSession.create({
        data: {
          userId: user.id,
          tokenHash: 'pending',
          expiresAt: new Date(Date.now() + refreshTtl * 1000),
        },
      });
      await tx.refreshSession.update({
        where: { id: fromSessionId },
        data: { revokedAt: new Date(), replacedById: ns.id },
      });
      return ns;
    });
    const { accessToken, refreshToken } = await this.signTokens(user, role.name, session.id);
    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: role.name,
        permissions: await this.filteredPermissions(user, role),
      },
    };
  }
}
