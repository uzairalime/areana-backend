import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { StorageModule } from '../storage/storage.module';
import { OwnerController } from './owner.controller';
import { OwnerService } from './owner.service';

@Module({
  imports: [BookingsModule, StorageModule, ReviewsModule],
  controllers: [OwnerController],
  providers: [OwnerService],
})
export class OwnerModule {}
