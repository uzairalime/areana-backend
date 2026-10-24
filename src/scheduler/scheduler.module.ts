import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PromosModule } from '../promos/promos.module';
import { SchedulerService } from './scheduler.service';
import { PlansModule } from '../plans/plans.module';
import { BookingsModule } from '../bookings/bookings.module';

@Module({
  imports: [ScheduleModule.forRoot(), PromosModule, PlansModule, BookingsModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
