import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  imports: [AuthModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
