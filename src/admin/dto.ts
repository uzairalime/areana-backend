import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// --------------------------------------------------------------- users
export class CreateUserDto {
  @ApiProperty() @IsString() email: string;
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^\+?[0-9\s()\-]{7,20}$/, { message: 'Phone must be 7–20 characters of digits, spaces, +, - or ()' }) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(8) @MaxLength(72) password?: string;
  @ApiProperty({ description: 'Role id' }) @IsString() roleId: string;
}

export class SetUserRoleDto {
  @ApiProperty() @IsString() roleId: string;
}

export class SetUserStatusDto {
  @ApiProperty({ enum: ['pending', 'active', 'suspended'] })
  @IsIn(['pending', 'active', 'suspended'])
  status: 'pending' | 'active' | 'suspended';
}

// --------------------------------------------------------------- roles
export class CreateRoleDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty({ enum: ['platform', 'arena'] }) @IsIn(['platform', 'arena']) scope: 'platform' | 'arena';
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) permissions: string[];
}

export class UpdateRoleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[];
}

// --------------------------------------------------------------- venues
export class SetStaffRolesDto {
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) roleIds: string[];
}

// --------------------------------------------------------------- promos
export class CreatePromoDto {
  @ApiPropertyOptional() @IsOptional() @IsString() code?: string;
  @ApiProperty({ enum: ['percent', 'flat'] }) @IsIn(['percent', 'flat']) kind: 'percent' | 'flat';
  @ApiProperty() @IsNumber() @Min(0) value: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) maxDiscount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) maxUses?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) perUserLimit?: number;
  @ApiProperty() @IsString() validTo: string;
  @ApiPropertyOptional() @IsOptional() @IsString() validFrom?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdatePromoDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  // Value/dates/limits become editable once a promo exists (panel edit
  // modal). Code and kind stay immutable. The service applies the same
  // redeemed-promo freeze as the owner update path: terms may not
  // change after any redemption, and maxUses may not drop below
  // usedCount.
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) value?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) maxDiscount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) maxUses?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) perUserLimit?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() validFrom?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() validTo?: string;
}

export class ResetPasswordDto {
  @ApiProperty({ minLength: 8, maxLength: 72 })
  @IsString()
  @Min(8)
  @Max(72)
  newPassword: string;
}

// --------------------------------------------------------------- disputes
export class ResolveDisputeDto {
  // No `credit` action: no credit mechanism exists, and resolving as
  // "credit" while delivering nothing is worse than refusing it.
  @ApiProperty({ enum: ['confirm_no_show', 'dismiss'] })
  @IsIn(['confirm_no_show', 'dismiss'])
  action: 'confirm_no_show' | 'dismiss';
  @ApiPropertyOptional() @IsOptional() @IsString() resolution?: string;
}

// --------------------------------------------------------------- broadcast
export class SendBroadcastDto {
  @ApiProperty() @IsString() title: string;
  @ApiProperty() @IsString() body: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
}

export class CreateBannerDto {
  @ApiProperty() @IsString() title: string;
  @ApiProperty() @IsString() imageUrl: string;
  @ApiPropertyOptional() @IsOptional() @IsString() blurhash?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() linkUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() endsAt?: string;
}

export class UpdateBannerDto {
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() blurhash?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() linkUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() endsAt?: string;
}

// --------------------------------------------------------------- misc
export class SetSuggestionStatusDto {
  @ApiProperty({ enum: ['new', 'contacted', 'converted', 'dismissed'] })
  @IsIn(['new', 'contacted', 'converted', 'dismissed'])
  status: string;
}

export class UpdateSettingsDto {
  @ApiProperty({ example: { commissionPct: '10' } })
  settings: Record<string, string>;
}

export class AnalyticsQueryDto {
  @ApiPropertyOptional({ example: 30 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) days?: number = 30;
  @ApiPropertyOptional({ enum: ['day', 'week', 'month'] }) @IsOptional() @IsIn(['day', 'week', 'month']) granularity?: 'day' | 'week' | 'month' = 'day';
  /** Inclusive start date (YYYY-MM-DD, PKT day). Overrides `days` when set. */
  @ApiPropertyOptional({ example: '2026-10-01' }) @IsOptional() @IsString() from?: string;
  /** Inclusive end date (YYYY-MM-DD, PKT day). */
  @ApiPropertyOptional({ example: '2026-10-24' }) @IsOptional() @IsString() to?: string;
}

// --------------------------------------------------------------- onboarding
export class OnboardCourtDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsString() sport: string;
  @ApiPropertyOptional() @IsOptional() @IsString() size?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() surface?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() indoor?: boolean;
  @ApiProperty() @IsNumber() @Min(0) pricePerHour: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) openMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) closeMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(15) slotMinutes?: number;
}

export class OnboardArenaDto {
  // owner account
  @ApiProperty() @IsString() ownerName: string;
  @ApiProperty() @IsString() ownerEmail: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^\+?[0-9\s()\-]{7,20}$/, { message: 'Phone must be 7–20 characters of digits, spaces, +, - or ()' }) ownerPhone?: string;
  @ApiProperty({ description: 'Initial password for the owner login' })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  ownerPassword: string;
  // venue
  @ApiProperty() @IsString() venueName: string;
  @ApiProperty() @IsString() address: string;
  @ApiProperty() @IsString() city: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^\+?[0-9\s()\-]{7,20}$/, { message: 'Phone must be 7–20 characters of digits, spaces, +, - or ()' }) venuePhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) sports?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) amenities?: string[];
  // plan + go-live
  @ApiPropertyOptional({ description: 'Plan to put the venue on; default plan when omitted' })
  @IsOptional()
  @IsString()
  planId?: string;
  @ApiPropertyOptional({ description: 'Submit for approval (pending) instead of leaving a draft; the venue goes live via the approve action once readiness requirements (photos etc.) are met' })
  @IsOptional()
  @IsBoolean()
  approveNow?: boolean;
  // courts
  @ApiPropertyOptional({ type: [OnboardCourtDto] })
  @IsOptional()
  @IsArray()
  courts?: OnboardCourtDto[];
}


export class AdminUpdateVenueDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^\+?[0-9\s()\-]{7,20}$/, { message: 'Phone must be 7–20 characters of digits, spaces, +, - or ()' }) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) sports?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) amenities?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() autoAccept?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) minAdvanceMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) maxAdvanceDays?: number;
}


export class AdminCreateCourtDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty({ example: 'Football' }) @IsString() sport: string;
  @ApiPropertyOptional() @IsOptional() @IsString() size?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() surface?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() indoor?: boolean;
  @ApiProperty({ example: 2500 }) @IsNumber() @Min(0) pricePerHour: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() openMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() closeMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() slotMinutes?: number;
}

export class AdminUpdateCourtDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() sport?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() size?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() surface?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() indoor?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) pricePerHour?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() openMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() closeMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() slotMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}


export class SetCourtLimitDto {
  @ApiPropertyOptional({ description: 'Max courts the owner may create at this arena; null = use the plan default' })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number | null;
  @ApiPropertyOptional({ description: 'Allow the new limit even when current usage is above it (audited)' })
  @IsOptional()
  @IsBoolean()
  confirmBelowUsage?: boolean;
}


export class SetStaffLimitDto {
  @ApiPropertyOptional({ description: 'Max team seats at this arena; null = use the plan default' })
  @IsOptional()
  @IsInt()
  @Min(0)
  limit?: number | null;
  @ApiPropertyOptional({ description: 'Allow the new limit even when current usage is above it (audited)' })
  @IsOptional()
  @IsBoolean()
  confirmBelowUsage?: boolean;
}
