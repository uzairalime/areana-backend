import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAmenityDto {
  @ApiProperty({ example: 'Parking' }) @IsString() @MinLength(2) @MaxLength(40) name: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
}

export class UpdateAmenityDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(40) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
