import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePerm } from '../common/auth';
import { DisputesService } from './disputes.service';
import { CreateDisputeDto } from './dto';

@ApiTags('disputes')
@ApiBearerAuth()
@RequirePerm('bookings.read')
@Controller('disputes')
export class DisputesController {
  constructor(private disputes: DisputesService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDisputeDto) {
    return this.disputes.create(user.id, dto);
  }

  @Get('me')
  listMine(@CurrentUser() user: AuthUser) {
    return this.disputes.listMine(user.id);
  }
}
