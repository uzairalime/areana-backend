import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { BadgesModule } from '../badges/badges.module';
import { DisputesModule } from '../disputes/disputes.module';
import { SuggestionsModule } from '../suggestions/suggestions.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { BookingsModule } from '../bookings/bookings.module';
import { PlansModule } from '../plans/plans.module';
import { SportsModule } from '../sports/sports.module';
import { AmenitiesModule } from '../amenities/amenities.module';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [BadgesModule, BookingsModule, DisputesModule, SuggestionsModule, StorageModule, PlansModule, SportsModule, AmenitiesModule],
  controllers: [AdminController],
  providers: [AdminService, AnalyticsService],
})
export class AdminModule {}
