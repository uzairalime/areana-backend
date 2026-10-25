import { Module } from '@nestjs/common';
import { FavoritesController } from './favorites.controller';
import { FavoritesService } from './favorites.service';
import { PlansModule } from '../plans/plans.module';

@Module({
  // Round 5, P5-S54: FavoritesService needs PlansService for the
  // computed live-overdue check. No cycle: PlansModule imports
  // BookingsModule, never FavoritesModule.
  imports: [PlansModule],
  controllers: [FavoritesController],
  providers: [FavoritesService],
  exports: [FavoritesService],
})
export class FavoritesModule {}
