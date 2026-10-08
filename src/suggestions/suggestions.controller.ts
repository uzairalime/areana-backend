import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth';
import { SuggestionsService } from './suggestions.service';
import { CreateVenueSuggestionDto } from './dto';

@ApiTags('suggestions')
@ApiBearerAuth()
@Controller('venue-suggestions')
export class SuggestionsController {
  constructor(private suggestions: SuggestionsService) {}

  // Any authenticated user; no specific permission required.
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateVenueSuggestionDto) {
    return this.suggestions.create(user.id, dto);
  }
}
