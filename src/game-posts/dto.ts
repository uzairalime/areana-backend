import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { OffsetQueryDto } from '../common/pagination';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateGamePostDto {
  /**
   * Player path: post FROM one of your confirmed bookings — venue, court,
   * sport, date and time are all derived from the booking. The free-form
   * fields below exist only for super-admin (curated) posts.
   */
  @ApiPropertyOptional({ description: 'Your confirmed booking to post from' })
  @IsOptional()
  @IsString()
  bookingId?: string;

  @ApiPropertyOptional({ example: 6, description: 'How many players you already have (incl. you)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  squadSize?: number;

  @ApiProperty({ example: 'Football' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  sport?: string;

  @ApiProperty({ example: 'Lahore' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  city?: string;

  @ApiPropertyOptional({ example: 'clx...' })
  @IsOptional()
  @IsString()
  venueId?: string;

  @ApiProperty({ example: '2026-10-10' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  @ApiProperty({ example: 1080 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1800)
  startMinutes?: number;

  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(1)
  @Max(50)
  playersNeeded: number;

  @ApiPropertyOptional({ example: 'Intermediate', description: 'Skill level shown on the board (e.g. Casual, Intermediate, Competitive)' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  level?: string;

  @ApiPropertyOptional({ example: 'Need a goalkeeper' })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}

export class UpdateGamePostDto {
  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  playersNeeded?: number;

  @ApiPropertyOptional({ example: 6 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  squadSize?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  level?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(280)
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

export class GamePostQueryDto extends OffsetQueryDto {
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

  @ApiPropertyOptional({
    enum: ['open', 'full', 'closed'],
    default: 'open',
    description: 'Board status filter; defaults to open (the player board). Non-open views skip the future-only date rule so past posts stay visible.',
  })
  @IsOptional()
  @IsString()
  @IsIn(['open', 'full', 'closed'])
  status?: string;

  @ApiPropertyOptional({ enum: ['distance'], description: 'distance = nearest venue first (needs lat + lng); otherwise the board default (curated, then date/time).' })
  @IsOptional()
  @IsString()
  @IsIn(['distance'])
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
