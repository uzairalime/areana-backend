import { Module } from '@nestjs/common';
import { ReferralsController } from './referrals.controller';
import { PromosService } from './promos.service';
import { ReferralsService } from './referrals.service';

@Module({
  controllers: [ReferralsController],
  providers: [PromosService, ReferralsService],
  exports: [PromosService, ReferralsService],
})
export class PromosModule {}
