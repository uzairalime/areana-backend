import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
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
  async getMe(@CurrentUser() user: AuthUser) {
    // The bcrypt hash must never leave the server: every other user
    // endpoint strips it, and these two returned the raw row.
    const { passwordHash: _passwordHash, ...me } = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { role: { select: { name: true } } },
    });
    return me;
  }

  @Patch('me')
  async updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    // Round 5, R5-S12 (policy, chosen consistently): blank fields are
    // IGNORED per-field, never a whole-PATCH failure and never a
    // clear — a partial edit sending { name: "New Name", city: "" }
    // now saves the name and leaves the city untouched, instead of
    // 400ing and discarding the valid change too. There is therefore
    // still no way to CLEAR a field via this endpoint (a cleared
    // panel field is omitted by the panel, which is the same outcome);
    // clearing, if ever wanted, must be an explicit null contract,
    // not a blank string. Non-blank values are trimmed as before,
    // and a non-blank phone with no digits is still rejected.
    const data: { name?: string; phone?: string; city?: string } = {};
    if (dto.name != null) {
      const name = dto.name.trim();
      if (name) data.name = name;
    }
    if (dto.phone != null) {
      const phone = dto.phone.trim();
      if (phone) {
        if (!/^\+?[0-9\s\-()]+$/.test(phone) || !/\d/.test(phone)) {
          throw new BadRequestException('Phone number is not valid');
        }
        data.phone = phone;
      }
    }
    if (dto.city != null) {
      const city = dto.city.trim();
      if (city) data.city = city;
    }
    if (Object.keys(data).length === 0) {
      const { passwordHash: _p, ...current } = await this.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      return current;
    }
    const { passwordHash: _passwordHash, ...me } = await this.prisma.user.update({
      where: { id: user.id },
      data,
    });
    return me;
  }

  /** Upload (or replace) the signed-in user's profile photo. */
  @Post('me/avatar')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('image'))
  async uploadAvatar(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File) {
    // No file used to 500 inside image processing (Round 4 trivial).
    if (!file) {
      throw new BadRequestException('No image file uploaded');
    }
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
    // The last active super admin must not delete themselves out of
    // the platform: demote and suspend both refuse it, and self-delete
    // must match — otherwise there is no in-product path left to admin
    // anything, and recovery is database surgery.
    const self = await this.prisma.user.findUnique({
      where: { id },
      include: { role: { select: { name: true } } },
    });
    if (self?.role?.name === 'super_admin') {
      const others = await this.prisma.user.count({
        where: {
          id: { not: id },
          status: UserStatus.active,
          role: { name: 'super_admin' },
        },
      });
      if (others === 0) {
        throw new BadRequestException(
          "You can't delete the last active super admin",
        );
      }
    }
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
            // Clear the frozen billing state too: a future startBilling()
            // checks only billingStartAt and would otherwise silently
            // re-anchor on this stale frozen period.
            billingPaidUntil: null,
            freeUntilOverride: null,
            billingPeriodStart: null,
            billingPeriodEnd: null,
            billingPeriodPrice: null,
            frozenPlanId: null,
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

  // Round 4, P-S9: device tokens used to survive sign-out AND password
  // change — the push channel outlived the credential rotation meant
  // to kill it, so a changed password ("log me out everywhere") still
  // left the old device receiving booking notices (venue, time,
  // amounts). Per-device sign-out: list + revoke one token; sign out
  // everywhere for push: revoke all. Logout and password change also
  // revoke (see auth.service) — these endpoints are the manual path.
  @Get('me/device-tokens')
  async listDeviceTokens(@CurrentUser() user: AuthUser) {
    return this.prisma.deviceToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Delete('me/device-tokens/:id')
  async revokeDeviceToken(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const res = await this.prisma.deviceToken.deleteMany({
      where: { id, userId: user.id },
    });
    return { revoked: res.count };
  }

  @Delete('me/device-tokens')
  async revokeAllDeviceTokens(@CurrentUser() user: AuthUser) {
    const res = await this.prisma.deviceToken.deleteMany({ where: { userId: user.id } });
    return { revoked: res.count };
  }
}
