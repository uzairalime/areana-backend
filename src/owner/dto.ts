import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { OffsetQueryDto } from '../common/pagination';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateVenueDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsString() address: string;
  @ApiProperty() @IsString() city: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^\+?[0-9\s()\-]{7,20}$/, { message: 'Phone must be 7–20 characters of digits, spaces, +, - or ()' }) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsString({ each: true }) sports?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsString({ each: true }) amenities?: string[];
}

export class UpdateVenueDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^\+?[0-9\s()\-]{7,20}$/, { message: 'Phone must be 7–20 characters of digits, spaces, +, - or ()' }) phone?: string;
  // CreateVenueDto always had lat/lng but Update did not — the global
  // ValidationPipe whitelist silently STRIPPED them, so editing a
  // venue's coordinates in the panel never persisted.
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsString({ each: true }) sports?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsString({ each: true }) amenities?: string[];
  @ApiPropertyOptional() @IsOptional() autoAccept?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) minAdvanceMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) maxAdvanceDays?: number;
}

export class CreateCourtDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty({ example: 'Football' }) @IsString() sport: string;
  @ApiPropertyOptional({ example: '7v7' }) @IsOptional() @IsString() size?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() surface?: string;
  @ApiPropertyOptional() @IsOptional() indoor?: boolean;
  @ApiProperty({ example: 2500 }) @IsNumber() @Min(0) pricePerHour: number;
  @ApiPropertyOptional({ example: 360 }) @IsOptional() @IsInt() openMinutes?: number;
  @ApiPropertyOptional({ example: 1380 }) @IsOptional() @IsInt() closeMinutes?: number;
  @ApiPropertyOptional({ example: 60 }) @IsOptional() @IsInt() slotMinutes?: number;
}

export class UpdateCourtDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() size?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() surface?: string;
  @ApiPropertyOptional() @IsOptional() indoor?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumber() pricePerHour?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() openMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() closeMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() slotMinutes?: number;
  @ApiPropertyOptional() @IsOptional() isActive?: boolean;
}

export class CreateBlockDto {
  @ApiProperty() @IsString() courtId: string;
  @ApiProperty({ example: '2026-10-08' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date: string;
  @ApiProperty({ example: 1080 }) @IsInt() startMinutes: number;
  @ApiProperty({ example: 1200 }) @IsInt() endMinutes: number;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

export class WalkInDto {
  @ApiProperty() @IsString() courtId: string;
  @ApiProperty({ example: '2026-10-08' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date: string;
  @ApiProperty({ example: 1080 }) @IsInt() startMinutes: number;
  @ApiPropertyOptional({ example: 1 }) @IsOptional() @IsInt() @Min(1) slotCount?: number;
  @ApiProperty({ example: 'Walk-in guest' }) @IsString() guestName: string;
}

export class RejectDto {
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

export class ResetPasswordDto {
  @ApiProperty({ minLength: 8, maxLength: 72 })
  @IsString()
  @Min(8)
  @Max(72)
  newPassword: string;
}

export class CheckInScanDto {
  @ApiProperty() @IsString() code: string;
  @ApiProperty() @IsString() venueId: string;
}

export class CreateStaffDto {
  @ApiProperty() @IsString() email: string;
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(72) password: string;
  @ApiProperty({ description: 'Must be one of the venue’s allowed roles' })
  @IsString()
  roleId: string;
}

export class ReplyReviewDto {
  @ApiProperty() @IsString() reply: string;
}

export class BookingsQueryDto extends OffsetQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() venueId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['pending', 'confirmed', 'cancelled', 'completed', 'no_show'])
  status?: string;
}

// ------------------------------------------------------- availability manager
export class WeeklyWindowDto {
  @ApiProperty({ example: 360 }) @IsInt() @Min(0) startMinutes: number;
  @ApiProperty({ example: 1380 }) @IsInt() @Min(0) endMinutes: number;
}

export class WeeklyDayDto {
  @ApiProperty({ example: 1, description: '0 = Sunday … 6 = Saturday' })
  @IsInt()
  @Min(0)
  weekday: number;
  @ApiProperty({ type: [WeeklyWindowDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyWindowDto)
  windows: WeeklyWindowDto[];
}

export class SetWeeklyHoursDto {
  @ApiProperty({ type: [WeeklyDayDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyDayDto)
  days: WeeklyDayDto[];
  @ApiPropertyOptional({
    description:
      'Set true to save even when existing bookings conflict (they are kept).',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeConflicts?: boolean;
}

export class CreateRecurringBlockDto {
  @ApiProperty({ type: [Number], example: [5], description: '0 = Sunday … 6 = Saturday' })
  @IsArray()
  @IsInt({ each: true })
  weekdays: number[];
  @ApiProperty({ example: 750 }) @IsInt() @Min(0) startMinutes: number;
  @ApiProperty({ example: 870 }) @IsInt() @Min(0) endMinutes: number;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startsOn?: string;
  @ApiPropertyOptional({ example: '2026-11-30' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endsOn?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  acknowledgeConflicts?: boolean;
}

export class CreateClosureDto {
  @ApiProperty({ example: '2026-10-20' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date: string;
  @ApiPropertyOptional({ description: 'Omit to close every court of the venue.' })
  @IsOptional()
  @IsString()
  courtId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

export class CreatePriceWindowDto {
  @ApiProperty({ type: [Number], example: [1, 2, 3, 4, 5], description: '0 = Sunday … 6 = Saturday' })
  @IsArray()
  @IsInt({ each: true })
  weekdays: number[];
  @ApiProperty({ example: 1020, description: '17:00' }) @IsInt() @Min(0) startMinutes: number;
  @ApiProperty({ example: 1380, description: '23:00' }) @IsInt() @Min(0) endMinutes: number;
  @ApiProperty({ example: 3500, description: 'Rs per hour during this window' })
  @IsNumber()
  @Min(0)
  pricePerHour: number;
  @ApiPropertyOptional({ example: '2026-12-01' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startsOn?: string;
  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endsOn?: string;
}

// ------------------------------------------------------------ own roles
export class CreateMyRoleDto {
  @ApiProperty({ example: 'Manager' }) @IsString() name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty({ type: [String], description: 'Arena permission keys' })
  @IsArray()
  @IsString({ each: true })
  permissions: string[];
}

export class UpdateMyRoleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}

// ------------------------------------------------------------ own promos
export class CreateMyPromoDto {
  @ApiProperty() @IsString() venueId: string;
  @ApiProperty({ example: 'EID20' }) @IsString() code: string;
  @ApiProperty({ enum: ['percent', 'flat'] }) @IsIn(['percent', 'flat']) kind: string;
  @ApiProperty() @IsNumber() @Min(0) value: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) maxDiscount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) maxUses?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) perUserLimit?: number;
  @ApiProperty({ description: 'ISO date the promo stops working' }) @IsString() validTo: string;
  @ApiPropertyOptional({ description: 'ISO date the promo starts working (default: now)' }) @IsOptional() @IsString() validFrom?: string;
}

export class UpdateMyPromoDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) value?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) maxDiscount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) maxUses?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) perUserLimit?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() validTo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() validFrom?: string;
}
