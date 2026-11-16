import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth';
import { BroadcastsService } from './broadcasts.service';
import { wrapList } from '../common/pagination';

@ApiTags('banners')
@Controller('banners')
export class BroadcastsController {
  constructor(private broadcasts: BroadcastsService) {}

  @Public()
  @Get()
  async list(@Query('city') city?: string) {
    return wrapList(await this.broadcasts.listBanners(city));
  }
}
