import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlansService } from './plans.service';

@Module({
  imports: [NotificationsModule],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
