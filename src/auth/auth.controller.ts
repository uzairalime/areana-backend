import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Ip,
  Post,
  UseFilters,
} from '@nestjs/common';
import { Throttle, ThrottlerException } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

/**
 * Round 5, R5-20 (throttler half): the route-level 10/min throttle
 * fires before the handler, so the service's hourly-cap payload never
 * runs for it. This filter gives that 429 the same shape: the
 * throttle window is 60s, so retryAfterSeconds is the window (an
 * upper bound — the true reset is sooner if the window started
 * earlier) and resetsAt is now + 60s. Scoped to request-otp only.
 */
@Catch(ThrottlerException)
export class OtpThrottleFilter implements ExceptionFilter {
  catch(_exception: ThrottlerException, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const now = Date.now();
    res.status(429).json({
      statusCode: 429,
      message: 'Too many codes requested. Try again in a minute.',
      retryAfterSeconds: 60,
      resetsAt: new Date(now + 60_000).toISOString(),
    });
  }
}
import { AuthUser, CurrentUser, Public } from '../common/auth';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  LogoutDto,
  OwnerRegisterDto,
  RefreshDto,
  RequestOtpDto,
  StaffLoginDto,
  VerifyOtpDto,
} from './dto';

@ApiTags('auth')
@Throttle({ default: { limit: 30, ttl: 60000 } })
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  // --- players: passwordless email OTP ---
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseFilters(OtpThrottleFilter)
  @Post('request-otp')
  requestOtp(@Body() dto: RequestOtpDto, @Ip() ip: string) {
    return this.auth.requestOtp(dto, ip);
  }

  @Public()
  @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto);
  }

  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto);
  }

  /** Revokes the refresh session behind the given refresh token. */
  @Public()
  @Post('logout')
  logout(@Body() dto: LogoutDto) {
    return this.auth.logout(dto.refreshToken, dto.deviceToken);
  }

  /** Signed-in password accounts (owner/staff/admin) rotate their password. */
  @Post('change-password')
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto);
  }

  // --- arena owners self-register (super admin approves) ---
  @Public()
  @Post('owner/register')
  ownerRegister(@Body() dto: OwnerRegisterDto) {
    return this.auth.ownerRegister(dto);
  }

  // --- owner / staff / super_admin login (web panels) ---
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('staff/login')
  staffLogin(@Body() dto: StaffLoginDto) {
    return this.auth.staffLogin(dto);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  /** Round 5, R5-8: the caller's live refresh sessions. */
  @ApiBearerAuth()
  @Get('sessions')
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.listSessions(user.id);
  }

  /** Round 5, R5-8: revoke all of the caller's sessions + device tokens. */
  @ApiBearerAuth()
  @Post('logout-all')
  logoutAll(@CurrentUser() user: AuthUser) {
    return this.auth.logoutAll(user.id);
  }
}
