import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryVenuesDto {
  @ApiPropertyOptional({ example: 'Lahore' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: 'Football' })
  @IsOptional()
  @IsString()
  sport?: string;

  @ApiPropertyOptional({ example: 'turf' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ example: 'AstroTurf', description: 'Court surface (matches an active court)' })
  @IsOptional()
  @IsString()
  surface?: string;

  @ApiPropertyOptional({ enum: ['rating', 'price_asc', 'price_desc', 'name'], default: 'rating' })
  @IsOptional()
  @IsString()
  sort?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

export const VENUE_REPORT_CATEGORIES = [
  'fake_listing',
  'wrong_info',
  'closed',
  'misconduct',
  'unsafe',
  'other',
] as const;

export class ReportVenueDto {
  @IsIn(VENUE_REPORT_CATEGORIES)
  category!: (typeof VENUE_REPORT_CATEGORIES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  details?: string;
}
