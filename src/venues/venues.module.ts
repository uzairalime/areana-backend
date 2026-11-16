import { Module } from '@nestjs/common';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';
import { PlansModule } from '../plans/plans.module';

@Module({
  // Cycle-safe: nothing in the Plans → Bookings → Courts chain imports
  // VenuesService, so VenuesService may use PlansService for the
  // live-overdue check in cities().
  imports: [PlansModule],
  controllers: [VenuesController],
  providers: [VenuesService],
  exports: [VenuesService],
})
export class VenuesModule {}
