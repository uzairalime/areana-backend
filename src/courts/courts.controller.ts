import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth';
import { CourtsService } from './courts.service';

@ApiTags('courts')
@Controller()
export class CourtsController {
  constructor(private courts: CourtsService) {}

  @Public()
  @Get('venues/:venueId/courts')
  listByVenue(@Param('venueId') venueId: string) {
    return this.courts.listByVenue(venueId);
  }
}
