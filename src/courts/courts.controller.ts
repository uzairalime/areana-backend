import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth';
import { CourtsService } from './courts.service';
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
}
