import { Body, Controller, Delete, Get, Param, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { AuthUser, CurrentUser, RequirePerm } from '../common/auth';
import { PrismaService } from '../common/prisma';
import { BookingsService } from '../bookings/bookings.service';
import { StorageService } from '../storage/storage.service';
import { FileInterceptor } from '@nestjs/platform-express';

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
  constructor(
    private prisma: PrismaService,
    private bookings: BookingsService,
    private storage: StorageService,
  ) {}

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

  /** Upload (or replace) the signed-in user's profile photo. */
  @Post('me/avatar')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('image'))
  async uploadAvatar(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File) {
    const saved = await this.storage.saveAvatarImage(user.id, file);
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { avatarUrl: saved.url },
    });
    return { avatarUrl: updated.avatarUrl, blurhash: saved.blurhash };
  }

  /** Remove the signed-in user's profile photo. */
  @Delete('me/avatar')
  async removeAvatar(@CurrentUser() user: AuthUser) {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { avatarUrl: null },
    });
    return { avatarUrl: updated.avatarUrl };
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
    // Leave nothing live behind: future bookings are cancelled (venue
    // owners told), hosted games come down, and squad spots are given
    // back — then the profile itself is anonymized below.
    await this.bookings.cancelFutureBookings(
      id,
      'because the player deleted their account',
    );
    await this.bookings.exitGames(id);
    await this.bookings.deleteHostedPosts(id);
    // An owner deleting their account must not leave live arenas
    // behind: upcoming bookings AT their venues are cancelled first
    // (players notified by the shared helper), then each venue is
    // archived and its billing clock stopped. Stopping the clock
    // means billingStartAt = null — the nightly sweep only touches
    // venues with a start date — and billingPaused = true, so the
    // venue stays hidden even if the sweep runs before the archive
    // propagates. Ledger rows stay for history; the venue rows
    // themselves stay (archived) so past bookings and reviews still
    // resolve instead of dangling.
    const owned = await this.prisma.venue.findMany({
      where: { ownerId: id },
      select: { id: true, archivedAt: true },
    });
    for (const v of owned) {
      await this.bookings.cancelVenueUpcomingBookings(
        v.id,
        'the arena owner deleted their account',
      );
    }
    const me = await this.prisma.user.findUnique({
      where: { id },
      select: { avatarUrl: true },
    });
    await this.prisma.$transaction([
      ...owned.map((v) =>
        this.prisma.venue.update({
          where: { id: v.id },
          data: {
            archivedAt: v.archivedAt ?? new Date(),
            billingPaused: true,
            billingStartAt: null,
          },
        }),
      ),
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
      this.prisma.auditLog.create({
        data: {
          actorId: id,
          action: 'user.delete_me',
          entity: 'user',
          entityId: id,
          details: `archived ${owned.length} owned venue(s), billing stopped`,
        },
      }),
    ]);
    // The avatar file goes with the account (best-effort — deleteImage
    // logs failures internally and never throws).
    if (me?.avatarUrl) await this.storage.deleteImage(me.avatarUrl);
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
