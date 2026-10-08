import { Module } from '@nestjs/common';
import { GamePostsController } from './game-posts.controller';
import { GamePostsService } from './game-posts.service';

@Module({
  controllers: [GamePostsController],
  providers: [GamePostsService],
  exports: [GamePostsService],
})
export class GamePostsModule {}
