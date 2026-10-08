import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, Public, RequirePerm } from '../common/auth';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto';

@ApiTags('reviews')
@Controller()
export class ReviewsController {
  constructor(private reviews: ReviewsService) {}

  @RequirePerm('reviews.write')
  @Post('reviews')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateReviewDto) {
    return this.reviews.create(user.id, dto);
  }

  @Public()
  @Get('venues/:id/reviews')
  listByVenue(@Param('id') id: string) {
    return this.reviews.listByVenue(id);
  }
}
