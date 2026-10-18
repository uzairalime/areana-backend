import { Body, Controller, Get, Ip, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, Public } from '../common/auth';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
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
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
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
}
