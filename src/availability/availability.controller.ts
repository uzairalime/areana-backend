import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth';
import { AvailabilityService } from './availability.service';

@ApiTags('availability')
@Controller('courts/:courtId/availability')
export class AvailabilityController {
  constructor(private availability: AvailabilityService) {}

  @Public()
  @Get()
  @ApiQuery({ name: 'date', example: '2026-10-08', description: 'YYYY-MM-DD' })
  get(@Param('courtId') courtId: string, @Query('date') date: string) {
    return this.availability.getAvailability(courtId, date);
  }
}
