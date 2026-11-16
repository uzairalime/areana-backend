import { Module } from '@nestjs/common';
import { SportsService } from './sports.service';
import { AdminSportsController, SportsController } from './sports.controller';

@Module({
  controllers: [SportsController, AdminSportsController],
  providers: [SportsService],
  exports: [SportsService],
})
export class SportsModule {}
