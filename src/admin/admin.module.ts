import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { BadgesModule } from '../badges/badges.module';
import { DisputesModule } from '../disputes/disputes.module';
import { SuggestionsModule } from '../suggestions/suggestions.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PlansModule } from '../plans/plans.module';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [BadgesModule, DisputesModule, SuggestionsModule, StorageModule, PlansModule],
  controllers: [AdminController],
  providers: [AdminService, AnalyticsService],
})
export class AdminModule {}
