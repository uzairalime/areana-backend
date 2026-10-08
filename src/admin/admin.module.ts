import { Module } from '@nestjs/common';
import { BadgesModule } from '../badges/badges.module';
import { DisputesModule } from '../disputes/disputes.module';
import { SuggestionsModule } from '../suggestions/suggestions.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [BadgesModule, DisputesModule, SuggestionsModule],
  controllers: [AdminController],
  providers: [AdminService, AnalyticsService],
})
export class AdminModule {}
