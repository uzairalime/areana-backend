import { Controller, Get, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth';
import { SearchService } from './search.service';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private search: SearchService) {}

  @Public()
  @Get('slots')
  @ApiQuery({ name: 'date', required: true, example: '2026-10-08' })
  @ApiQuery({ name: 'sport', required: false, example: 'Football' })
  @ApiQuery({ name: 'city', required: false, example: 'Lahore' })
  @ApiQuery({ name: 'size', required: false, example: '7v7' })
  @ApiQuery({ name: 'indoor', required: false, type: Boolean })
  slotSearch(
    @Query('date') date: string,
    @Query('sport') sport?: string,
    @Query('city') city?: string,
    @Query('size') size?: string,
    @Query('indoor') indoor?: string,
  ) {
    return this.search.slotSearch({
      date,
      sport,
      city,
      size,
      indoor: indoor === undefined ? undefined : indoor === 'true',
    });
  }
}
