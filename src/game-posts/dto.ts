import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateGamePostDto {
  @ApiProperty({ example: 'Football' })
  @IsString()
  sport: string;

  @ApiProperty({ example: 'Lahore' })
  @IsString()
  city: string;

  @ApiPropertyOptional({ example: 'clx...' })
  @IsOptional()
  @IsString()
  venueId?: string;

  @ApiProperty({ example: '2026-10-10' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiProperty({ example: 1080 })
  @IsInt()
  @Min(0)
  startMinutes: number;

  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(1)
  playersNeeded: number;

  @ApiPropertyOptional({ example: 'Need a goalkeeper' })
  @IsOptional()
  @IsString()
  note?: string;
}

export class JoinGamePostDto {
  @ApiPropertyOptional({ description: 'Defaults to your profile name' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Defaults to your profile phone' })
  @IsOptional()
  @IsString()
  phone?: string;
}

export class GamePostQueryDto {
  @ApiPropertyOptional({ example: 'Football' })
  @IsOptional()
  @IsString()
  sport?: string;

  @ApiPropertyOptional({ example: 'Lahore' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: '2026-10-10' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
