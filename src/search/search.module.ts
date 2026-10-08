import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [AvailabilityModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
