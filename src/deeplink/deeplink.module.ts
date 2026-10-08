import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { VenuesModule } from '../venues/venues.module';
import { DeeplinkController } from './deeplink.controller';

@Module({
  imports: [BookingsModule, VenuesModule],
  controllers: [DeeplinkController],
})
export class DeeplinkModule {}
