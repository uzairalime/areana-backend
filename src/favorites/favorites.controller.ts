import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePerm } from '../common/auth';
import { FavoritesService } from './favorites.service';
import { FavoriteVenueDto } from './dto';

@ApiTags('favorites')
@ApiBearerAuth()
@RequirePerm('favorites.manage')
@Controller('favorites')
export class FavoritesController {
  constructor(private favorites: FavoritesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.favorites.list(user.id);
  }

  @Post()
  add(@CurrentUser() user: AuthUser, @Body() dto: FavoriteVenueDto) {
    return this.favorites.add(user.id, dto.venueId);
  }

  @Delete(':venueId')
  remove(@CurrentUser() user: AuthUser, @Param('venueId') venueId: string) {
    return this.favorites.remove(user.id, venueId);
  }
}
