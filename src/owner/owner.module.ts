import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { CourtsModule } from '../courts/courts.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { StorageModule } from '../storage/storage.module';
import { OwnerController } from './owner.controller';
import { OwnerService } from './owner.service';
import { PlansModule } from '../plans/plans.module';

@Module({
  imports: [BookingsModule, StorageModule, ReviewsModule, CourtsModule, PlansModule],
  controllers: [OwnerController],
  providers: [OwnerService],
})
export class OwnerModule {}
