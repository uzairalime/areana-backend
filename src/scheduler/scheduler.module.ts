import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PromosModule } from '../promos/promos.module';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [ScheduleModule.forRoot(), PromosModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
