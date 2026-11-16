import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlansService } from './plans.service';
import { BookingsModule } from '../bookings/bookings.module';

@Module({
  imports: [NotificationsModule, BookingsModule],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
