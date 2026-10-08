import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, Public } from '../common/auth';
import { AuthService } from './auth.service';
import {
  OwnerRegisterDto,
  RefreshDto,
  RequestOtpDto,
  StaffLoginDto,
  VerifyOtpDto,
} from './dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  // --- players: passwordless email OTP ---
  @Public()
  @Post('request-otp')
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto);
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

  // --- arena owners self-register (super admin approves) ---
  @Public()
  @Post('owner/register')
  ownerRegister(@Body() dto: OwnerRegisterDto) {
    return this.auth.ownerRegister(dto);
  }

  // --- owner / staff / super_admin login (web panels) ---
  @Public()
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
