import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth';
import { CourtsService } from './courts.service';
import { QueryCourtsDto } from './dto';
import { wrapList } from '../common/pagination';

@ApiTags('courts')
@Controller()
export class CourtsController {
  constructor(private courts: CourtsService) {}

  @Public()
  @Get('venues/:venueId/courts')
  async listByVenue(@Param('venueId') venueId: string) {
    return wrapList(await this.courts.listByVenue(venueId));
  }

  @Public()
  @Get('courts')
  async list(@Query() query: QueryCourtsDto) {
    return this.courts.list(query);
  }

  @Public()
  @Get('courts/:courtId')
  async getOne(@Param('courtId') courtId: string) {
    return this.courts.getOne(courtId);
  }
}
