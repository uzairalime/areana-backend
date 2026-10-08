import { IsIn, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
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

export class MyBookingsQueryDto {
  @ApiPropertyOptional({ enum: ['upcoming', 'past'], default: 'upcoming' })
  @IsOptional()
  @IsIn(['upcoming', 'past'])
  filter?: 'upcoming' | 'past' = 'upcoming';
}

export class JoinSharedDto {
  @ApiProperty({ example: 'Ahmed' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: '03001234567' })
  @IsOptional()
  @IsString()
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
