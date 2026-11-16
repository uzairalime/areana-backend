import { Module } from '@nestjs/common';
import { GamePostsController } from './game-posts.controller';
import { GamePostsService } from './game-posts.service';
import { PlansModule } from '../plans/plans.module';

@Module({
  // Round 5, P5-S54: GamePostsService needs PlansService for the
  // computed live-overdue check. No cycle: PlansModule imports
  // BookingsModule, never GamePostsModule.
  imports: [PlansModule],
  controllers: [GamePostsController],
  providers: [GamePostsService],
  exports: [GamePostsService],
})
export class GamePostsModule {}
