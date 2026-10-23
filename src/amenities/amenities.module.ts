import { Module } from '@nestjs/common';
import { AmenitiesService } from './amenities.service';
import { AdminAmenitiesController, AmenitiesController } from './amenities.controller';

@Module({
  controllers: [AmenitiesController, AdminAmenitiesController],
  providers: [AmenitiesService],
  exports: [AmenitiesService],
})
export class AmenitiesModule {}
