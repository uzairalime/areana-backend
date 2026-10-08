import { IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateVenueSuggestionDto {
  @ApiProperty({ example: 'Champions Turf' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'Lahore' })
  @IsString()
  city: string;

  @ApiPropertyOptional({ example: '03001234567' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: 'New 7v7 turf near DHA phase 6' })
  @IsOptional()
  @IsString()
  note?: string;
}
