import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { OffsetQueryDto } from '../common/pagination';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBookingDto {
  @ApiProperty({ example: 'clx...' })
  @IsString()
  courtId: string;

  @ApiProperty({ example: '2026-10-08' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiProperty({ example: 1080, description: 'Slot start, minutes since midnight (6 PM = 1080)' })
  @IsInt()
  @Min(0)
  startMinutes: number;

  @ApiPropertyOptional({ example: 2, description: 'Consecutive slots in one booking' })
  @IsOptional()
  @IsInt()
  @Min(1)
  slotCount?: number = 1;

  @ApiPropertyOptional({ example: 'WELCOME-AB12CD' })
  @IsOptional()
  @IsString()
  promoCode?: string;

  @ApiPropertyOptional({
    example: 1600,
    description:
      'Total the player saw at confirm time (net, after discount). When supplied, booking creation compares it in-transaction: a mismatch 400s with the new gross/total instead of booking at a new price on a blind retry (Round 5, R5-S8).',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  expectedTotal?: number;
}

export class CreateRecurringDto {
  @ApiProperty()
  @IsString()
  courtId: string;

  @ApiProperty({ example: 2, description: '0=Sunday … 6=Saturday' })
  @IsInt()
  @Min(0)
  dayOfWeek: number;

  @ApiProperty({ example: 1080 })
  @IsInt()
  @Min(0)
  startMinutes: number;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  slotCount?: number = 1;

  @ApiProperty({ example: 8, description: 'Number of weekly occurrences' })
  @IsInt()
  @Min(2)
  occurrences: number;
}

export class MyBookingsQueryDto extends OffsetQueryDto {
  @ApiPropertyOptional({ enum: ['upcoming', 'past'], default: 'upcoming' })
  @IsOptional()
  @IsIn(['upcoming', 'past'])
  filter?: 'upcoming' | 'past' = 'upcoming';
}

export class JoinSharedDto {
  @ApiProperty({ example: 'Ahmed' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  name: string;

  @ApiPropertyOptional({ example: '03001234567' })
  @IsOptional()
  @IsString()
  // Trimmed in the DTO; the service normalizes a blank phone to null,
  // which the partial unique index on (bookingId, phone) requires —
  // empty strings would otherwise collide across joiners (P5-T17).
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  phone?: string;
}

export class RequestRescheduleDto {
  @ApiProperty({ example: '2026-10-10' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiProperty({ example: 1140 })
  @IsInt()
  @Min(0)
  startMinutes: number;
}
