import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, Public, RequirePerm } from '../common/auth';
import { GamePostsService } from './game-posts.service';
import { CreateGamePostDto, GamePostQueryDto, UpdateGamePostDto } from './dto';

@ApiTags('game-posts')
@Controller('game-posts')
export class GamePostsController {
  constructor(private games: GamePostsService) {}

  @Public()
  @Get()
  list(@Query() query: GamePostQueryDto, @CurrentUser() user?: AuthUser) {
    return this.games.list(query, user?.id);
  }

  @Public()
  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() user?: AuthUser) {
    return this.games.getOne(id, user?.id);
  }

  @RequirePerm('games.manage')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateGamePostDto) {
    return this.games.create(user, dto);
  }

  @RequirePerm('games.manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateGamePostDto,
  ) {
    return this.games.update(id, user.id, dto);
  }

  @RequirePerm('games.manage')
  @Post(':id/join')
  join(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.games.join(id, user);
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
