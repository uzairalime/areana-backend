import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

// --- decorators ---
/** Require ALL listed permission keys (super_admin wildcard '*' passes). */
export const RequirePerm = (...perms: string[]) => SetMetadata('perms', perms);
/** Require AT LEAST ONE of the listed permission keys. */
export const RequireAnyPerm = (...perms: string[]) => SetMetadata('anyPerms', perms);
export const Public = () => SetMetadata('isPublic', true);

export interface AuthUser {
  id: string;
  email: string;
  roleId: string;
  roleName: string;
  permissions: string[];
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest().user,
);

// --- guards (registered globally in AppModule) ---
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}

@Injectable()
export class PermGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const perms = this.reflector.getAllAndOverride<string[]>('perms', [
      context.getHandler(),
      context.getClass(),
    ]);
    const anyPerms = this.reflector.getAllAndOverride<string[]>('anyPerms', [
      context.getHandler(),
      context.getClass(),
    ]);
    if ((!perms || perms.length === 0) && (!anyPerms || anyPerms.length === 0)) return true;
    const user = context.switchToHttp().getRequest().user as AuthUser;
    if (!user) return false;
    if (user.permissions.includes('*')) return true;
    if (perms && perms.length > 0 && !perms.every((p) => user.permissions.includes(p))) {
      return false;
    }
    if (anyPerms && anyPerms.length > 0 && !anyPerms.some((p) => user.permissions.includes(p))) {
      return false;
    }
    return true;
  }
}
