import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePlanDto {
  @ApiProperty({ example: 'Normal' })
  @IsString()
  @MaxLength(60)
  name: string;

  @ApiProperty({ example: 36000, description: 'Yearly fee in PKR' })
  @IsInt()
  @Min(0)
  priceYearly: number;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24)
  freeMonths?: number;

  @ApiPropertyOptional({ type: [String], description: 'Feature keys from the plan catalog' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];

  @ApiPropertyOptional({ description: 'Null = unlimited' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxVenues?: number | null;

  @ApiPropertyOptional({ description: 'Courts per venue; null = unlimited' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxCourts?: number | null;

  @ApiPropertyOptional({ description: 'Staff seats per venue; null = unlimited' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxStaff?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ description: 'Specialized plan built for one arena' })
  @IsOptional()
  @IsBoolean()
  isCustom?: boolean;
}

export class UpdatePlanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  priceYearly?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24)
  freeMonths?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  maxVenues?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  maxCourts?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  maxStaff?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ description: 'Allow the change even when a venue on this plan already uses more courts/staff than the new limits allow (audited)' })
  @IsOptional()
  @IsBoolean()
  confirmBelowUsage?: boolean;
}

export class AssignPlanDto {
  @ApiProperty()
  @IsString()
  planId: string;

  @ApiPropertyOptional({ description: 'Restart the billing clock from today' })
  @IsOptional()
  @IsBoolean()
  restartBilling?: boolean;

  @ApiPropertyOptional({ description: 'Allow the switch even when the venue already uses more courts/staff than the new plan allows (audited)' })
  @IsOptional()
  @IsBoolean()
  confirmBelowUsage?: boolean;
}

export class ExtendFreeDto {
  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(1)
  @Max(24)
  months: number;
}
