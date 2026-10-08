import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendBroadcastDto {
  @ApiProperty({ example: 'Weekend games are live!' })
  @IsString()
  title: string;

  @ApiProperty({ example: 'Book your Saturday slot today' })
  @IsString()
  body: string;

  @ApiPropertyOptional({ example: 'Lahore', description: 'Omit to target everyone' })
  @IsOptional()
  @IsString()
  city?: string;
}

export class CreateBannerDto {
  @ApiProperty({ example: '3 new turfs in DHA' })
  @IsString()
  title: string;

  @ApiProperty({ example: 'https://.../banner.jpg' })
  @IsString()
  imageUrl: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  linkUrl?: string;

  @ApiPropertyOptional({ example: 'Lahore', description: 'Omit for all cities' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  startsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  endsAt?: string;
}

export class UpdateBannerDto {
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() linkUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() startsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() endsAt?: string;
}
