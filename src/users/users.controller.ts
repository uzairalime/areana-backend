import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
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

  /**
   * Self-service account deletion: anonymizes the profile in place (so
   * owners keep truthful booking/revenue history), frees the email for a
   * future fresh signup, blocks all logins and revokes every session and
   * device token. Bookings and reviews stay, unattributed by name.
   */
  @Delete('me')
  async deleteMe(@CurrentUser() user: AuthUser) {
    const id = user.id;
    await this.prisma.$transaction([
      this.prisma.refreshSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.deviceToken.deleteMany({ where: { userId: id } }),
      this.prisma.favorite.deleteMany({ where: { userId: id } }),
      this.prisma.notification.deleteMany({ where: { userId: id } }),
      this.prisma.user.update({
        where: { id },
        data: {
          name: 'Deleted player',
          email: `deleted+${id}@areana.invalid`,
          phone: null,
          city: null,
          passwordHash: null,
          referralCode: null,
          noShowCount: 0,
          status: 'suspended',
          deletedAt: new Date(),
        },
      }),
    ]);
    return { ok: true };
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
