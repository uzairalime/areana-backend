import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, Public, RequirePerm } from '../common/auth';
import { GamePostsService } from './game-posts.service';
import { CreateGamePostDto, GamePostQueryDto, JoinGamePostDto } from './dto';

@ApiTags('game-posts')
@Controller('game-posts')
export class GamePostsController {
  constructor(private games: GamePostsService) {}

  @Public()
  @Get()
  list(@Query() query: GamePostQueryDto) {
    return this.games.list(query);
  }

  @RequirePerm('games.manage')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateGamePostDto) {
    return this.games.create(user.id, dto);
  }

  @RequirePerm('games.manage')
  @Post(':id/join')
  join(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: JoinGamePostDto,
  ) {
    return this.games.join(id, user, dto);
  }

  @RequirePerm('games.manage')
  @Post(':id/leave')
  leave(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.games.leave(id, user.id);
  }

  @RequirePerm('games.manage')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.games.remove(id, user.id);
  }
}
