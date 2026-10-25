import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { CourtsModule } from '../courts/courts.module';
import { WaitlistController } from './waitlist.controller';
import { WaitlistService } from './waitlist.service';

@Module({
  imports: [AvailabilityModule, CourtsModule],
  controllers: [WaitlistController],
  providers: [WaitlistService],
})
export class WaitlistModule {}
