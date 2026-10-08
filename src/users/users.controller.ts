import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { AuthUser, CurrentUser, RequirePerm } from '../common/auth';
import { PrismaService } from '../common/prisma';

class UpdateMeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
}

class DeviceTokenDto {
  @ApiProperty() @IsString() token: string;
  @ApiPropertyOptional() @IsOptional() @IsString() platform?: string;
}

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private prisma: PrismaService) {}

  @Get('me')
  getMe(@CurrentUser() user: AuthUser) {
    return this.prisma.user.findUnique({
      where: { id: user.id },
      include: { role: { select: { name: true } } },
    });
  }

  @Patch('me')
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.prisma.user.update({ where: { id: user.id }, data: dto });
  }

  @Post('me/device-tokens')
  async registerDeviceToken(@CurrentUser() user: AuthUser, @Body() dto: DeviceTokenDto) {
    return this.prisma.deviceToken.upsert({
      where: { token: dto.token },
      update: { userId: user.id, platform: dto.platform },
      create: { token: dto.token, userId: user.id, platform: dto.platform },
    });
  }
}
