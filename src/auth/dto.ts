import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RequestOtpDto {
  @ApiProperty({ example: 'player@example.com' })
  @IsEmail()
  email: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: 'player@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '482913' })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;

  // Required on first verification (= signup). Ignored for returning users.
  @ApiPropertyOptional({ example: 'Ahmed Khan' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: '03001234567' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: 'Lahore' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: 'AREANA-X7K2P9', description: "Referrer's code" })
  @IsOptional()
  @IsString()
  referralCode?: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  refreshToken: string;
}

export class LogoutDto extends RefreshDto {
  // Round 4, P-S9: the client passes its own push token so sign-out
  // also kills the push channel on that device (a shared/sold device
  // kept receiving booking notices after sign-out). Optional — old
  // clients that omit it keep the previous session-only behaviour.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  deviceToken?: string;
}

export class OwnerRegisterDto {
  @ApiProperty({ example: 'owner@arena.pk' })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @Length(8, 100)
  password: string;

  @ApiProperty({ example: 'Arena Owner' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: '03001234567' })
  @IsOptional()
  @IsString()
  phone?: string;
}

export class StaffLoginDto {
  @ApiProperty({ example: 'owner@arena.pk' })
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  password: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  currentPassword: string;

  @ApiProperty({ minLength: 8, maxLength: 72 })
  @IsString()
  @Length(8, 72)
  newPassword: string;
}
