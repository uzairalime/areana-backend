import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth';
import { BroadcastsService } from './broadcasts.service';

@ApiTags('banners')
@Controller('banners')
export class BroadcastsController {
  constructor(private broadcasts: BroadcastsService) {}

  @Public()
  @Get()
  list(@Query('city') city?: string) {
    return this.broadcasts.listBanners(city);
  }
}
