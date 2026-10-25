import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../common/prisma';
import { AuthUser } from '../common/auth';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow('jwt.accessSecret'),
    });
  }

  // Permissions are loaded per request (one indexed query) so panel-made
  // role changes take effect immediately — no redeploy, no token refresh.
  async validate(payload: { sub: string }): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: true },
    });
    if (!user || user.status !== 'active' || !user.role) {
      throw new UnauthorizedException('Invalid token');
    }
    let permissions = user.role.isActive ? user.role.permissions : [];
    // Round 4, L-B5: staff hired under another owner's role BEFORE
    // the allowed-roles fix still hold that role's live permissions —
    // the allowed-roles filter and createStaff rejection gate only NEW
    // assignments, and this strategy used to hand out
    // user.role.permissions with no VenueAllowedRole check. A
    // request-time check here: an arena role owned by someone else
    // only grants permissions when the holder actually staffs a venue
    // of that owner. A staffer at B's venue holding A's "Manager" role
    // gets zero permissions (fail closed) until an admin re-points
    // them; the legitimate case (A's staff at A's venues) is
    // unaffected. System roles (ownerId null) and a user's own roles
    // skip the check. Backfill script 08 lists the affected users for
    // admin review.
    if (user.role.ownerId && user.role.ownerId !== user.id) {
      const staffsOwnersVenue = await this.prisma.venueStaff.findFirst({
        where: { userId: user.id, venue: { ownerId: user.role.ownerId } },
      });
      if (!staffsOwnersVenue) permissions = [];
    }
    return {
      id: user.id,
      email: user.email,
      roleId: user.roleId,
      roleName: user.role.name,
      permissions,
    };
  }
}
