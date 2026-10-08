import { Module } from '@nestjs/common';
import { CourtsModule } from '../courts/courts.module';
import { PromosModule } from '../promos/promos.module';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

@Module({
  imports: [CourtsModule, PromosModule],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
