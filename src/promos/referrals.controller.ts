import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePerm } from '../common/auth';
import { ReferralsService } from './referrals.service';

@ApiTags('referrals')
@ApiBearerAuth()
@RequirePerm('referrals.read')
@Controller('referrals')
export class ReferralsController {
  constructor(private referrals: ReferralsService) {}

  @Get('me')
  getMyReferral(@CurrentUser() user: AuthUser) {
    return this.referrals.getMyReferral(user.id);
  }
}
