import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth';
import { WaitlistService } from './waitlist.service';
import { wrapList } from '../common/pagination';
import { JoinWaitlistDto } from './dto';

@ApiTags('waitlist')
@Controller('waitlist')
export class WaitlistController {
  constructor(private waitlist: WaitlistService) {}

  @Post()
  join(@CurrentUser() user: AuthUser, @Body() dto: JoinWaitlistDto) {
    return this.waitlist.join(user.id, dto);
  }

  @Get('mine')
  async mine(@CurrentUser() user: AuthUser) {
    return wrapList(await this.waitlist.listMine(user.id));
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.waitlist.remove(user.id, id);
  }
}
