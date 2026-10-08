import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBadgeDto {
  @ApiProperty({ example: 'Top Arena' })
  @IsString()
  name: string;

  @ApiProperty({ example: 2, description: 'Higher tier = more prestigious' })
  @IsInt()
  @Min(0)
  tier: number;

  @ApiPropertyOptional({ example: 'Rating 4.8+, 90% acceptance, 50+ bookings' })
  @IsOptional()
  @IsString()
  criteriaDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  iconUrl?: string;
}

export class UpdateBadgeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  tier?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  criteriaDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  iconUrl?: string;
}
