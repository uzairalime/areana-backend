import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSportDto {
  @ApiProperty({ example: 'Football' }) @IsString() @MinLength(2) @MaxLength(40) name: string;
  @ApiPropertyOptional({ example: '⚽' }) @IsOptional() @IsString() @MaxLength(8) icon?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
}

export class UpdateSportDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(40) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(8) icon?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
