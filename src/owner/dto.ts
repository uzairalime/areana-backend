import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateVenueDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsString() address: string;
  @ApiProperty() @IsString() city: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() lng?: number;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsString({ each: true }) sports?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsString({ each: true }) amenities?: string[];
}

export class UpdateVenueDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsString({ each: true }) sports?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsString({ each: true }) amenities?: string[];
  @ApiPropertyOptional() @IsOptional() autoAccept?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() minAdvanceMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() maxAdvanceDays?: number;
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

export class CheckInScanDto {
  @ApiProperty() @IsString() code: string;
  @ApiProperty() @IsString() venueId: string;
}

export class CreateStaffDto {
  @ApiProperty() @IsString() email: string;
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsString() password: string;
  @ApiProperty({ description: 'Must be one of the venue’s allowed roles' })
  @IsString()
  roleId: string;
}

export class ReplyReviewDto {
  @ApiProperty() @IsString() reply: string;
}

export class BookingsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() venueId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['pending', 'confirmed', 'cancelled', 'completed', 'no_show'])
  status?: string;
}
