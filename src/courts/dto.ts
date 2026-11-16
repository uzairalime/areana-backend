import { IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { OffsetQueryDto } from '../common/pagination';

/**
 * Public courts discovery (the courts list behind the browse Courts tab).
 * Courts have no rating of their own, so there is no `rating` sort — the
 * default is cheapest first. `distance` behaves exactly like the venues
 * list: pure nearest-first, venues without coordinates sort last.
 */
export class QueryCourtsDto extends OffsetQueryDto {
  @ApiPropertyOptional({ example: 'Turf A' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ example: 'Lahore' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: 'Football' })
  @IsOptional()
  @IsString()
  sport?: string;

  @ApiPropertyOptional({ example: 'artificial_grass' })
  @IsOptional()
  @IsString()
  surface?: string;

  @ApiPropertyOptional({ enum: ['price_asc', 'price_desc', 'distance', 'name'], default: 'price_asc' })
  @IsOptional()
  @IsString()
  @IsIn(['price_asc', 'price_desc', 'distance', 'name'])
  sort?: string;

  @ApiPropertyOptional({ example: 31.5204, description: 'Reference latitude for distance sort + distanceKm. Must be sent together with lng.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @ApiPropertyOptional({ example: 74.3587, description: 'Reference longitude for distance sort + distanceKm. Must be sent together with lat.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;
}
