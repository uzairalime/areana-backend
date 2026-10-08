import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// --------------------------------------------------------------- users
export class CreateUserDto {
  @ApiProperty() @IsString() email: string;
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() password?: string;
  @ApiProperty({ description: 'Role id' }) @IsString() roleId: string;
}

export class SetUserRoleDto {
  @ApiProperty() @IsString() roleId: string;
}

export class SetUserStatusDto {
  @ApiProperty({ enum: ['pending', 'active', 'suspended'] })
  @IsIn(['pending', 'active', 'suspended'])
  status: 'pending' | 'active' | 'suspended';
}

// --------------------------------------------------------------- roles
export class CreateRoleDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty({ enum: ['platform', 'arena'] }) @IsIn(['platform', 'arena']) scope: 'platform' | 'arena';
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) permissions: string[];
}

export class UpdateRoleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[];
}

// --------------------------------------------------------------- venues
export class SetStaffRolesDto {
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) roleIds: string[];
}

// --------------------------------------------------------------- promos
export class CreatePromoDto {
  @ApiPropertyOptional() @IsOptional() @IsString() code?: string;
  @ApiProperty({ enum: ['percent', 'flat'] }) @IsIn(['percent', 'flat']) kind: 'percent' | 'flat';
  @ApiProperty() @IsNumber() @Min(0) value: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) maxDiscount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) maxUses?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) perUserLimit?: number;
  @ApiProperty() @IsString() validTo: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdatePromoDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

// --------------------------------------------------------------- disputes
export class ResolveDisputeDto {
  @ApiProperty({ enum: ['confirm_no_show', 'dismiss', 'credit'] })
  @IsIn(['confirm_no_show', 'dismiss', 'credit'])
  action: 'confirm_no_show' | 'dismiss' | 'credit';
  @ApiPropertyOptional() @IsOptional() @IsString() resolution?: string;
}

// --------------------------------------------------------------- broadcast
export class SendBroadcastDto {
  @ApiProperty() @IsString() title: string;
  @ApiProperty() @IsString() body: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
}

export class CreateBannerDto {
  @ApiProperty() @IsString() title: string;
  @ApiProperty() @IsString() imageUrl: string;
  @ApiPropertyOptional() @IsOptional() @IsString() linkUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() endsAt?: string;
}

export class UpdateBannerDto {
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() linkUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() endsAt?: string;
}

// --------------------------------------------------------------- misc
export class SetSuggestionStatusDto {
  @ApiProperty({ enum: ['new', 'contacted', 'converted', 'dismissed'] })
  @IsIn(['new', 'contacted', 'converted', 'dismissed'])
  status: string;
}

export class UpdateSettingsDto {
  @ApiProperty({ example: { commissionPct: '10' } })
  settings: Record<string, string>;
}

export class AnalyticsQueryDto {
  @ApiPropertyOptional({ example: 30 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) days?: number = 30;
  @ApiPropertyOptional({ enum: ['day', 'week', 'month'] }) @IsOptional() @IsIn(['day', 'week', 'month']) granularity?: 'day' | 'week' | 'month' = 'day';
}
