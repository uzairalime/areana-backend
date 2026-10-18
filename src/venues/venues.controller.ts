import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth';
import { VenuesService } from './venues.service';
import { QueryVenuesDto } from './dto';

@ApiTags('venues')
@Controller('venues')
export class VenuesController {
  constructor(private venues: VenuesService) {}

  @Public()
  @Get()
  list(@Query() query: QueryVenuesDto) {
    return this.venues.list(query);
  }

  /** Distinct cities that have at least one approved venue (for filter dropdowns). */
  @Public()
  @Get('cities')
  cities() {
    return this.venues.cities();
  }

  @Public()
  @Get(':id')
  getById(@Param('id') id: string) {
    return this.venues.getById(id);
  }
}
