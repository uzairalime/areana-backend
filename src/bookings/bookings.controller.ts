import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, Public, RequirePerm } from '../common/auth';
import { BookingsService } from './bookings.service';
import { PromosService } from '../promos/promos.service';
import { CourtsService } from '../courts/courts.service';
import { parseDateOnly } from '../common/date.util';
import {
  CreateBookingDto,
  CreateRecurringDto,
  JoinSharedDto,
  MyBookingsQueryDto,
  RequestRescheduleDto,
} from './dto';

@ApiTags('bookings')
@Controller('bookings')
export class BookingsController {
  constructor(
    private bookings: BookingsService,
    private promos: PromosService,
    private courts: CourtsService,
  ) {}

  @ApiBearerAuth()
  @RequirePerm('bookings.create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateBookingDto) {
    return this.bookings.create({ ...dto, userId: user.id });
  }

  @ApiBearerAuth()
  @RequirePerm('bookings.create')
  @Post('recurring')
  createRecurring(@CurrentUser() user: AuthUser, @Body() dto: CreateRecurringDto) {
    return this.bookings.createRecurring(user.id, dto);
  }

  @ApiBearerAuth()
  @RequirePerm('bookings.read')
  @Get('me')
  listMine(@CurrentUser() user: AuthUser, @Query() query: MyBookingsQueryDto) {
    return this.bookings.listMine(user.id, query);
  }

  @ApiBearerAuth()
  @RequirePerm('bookings.read')
  @Patch(':id/cancel')
  cancelMine(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bookings.cancelMine(user.id, id);
  }

  @ApiBearerAuth()
  @RequirePerm('bookings.read')
  @Patch('recurring/:recurrenceId/cancel')
  cancelSeries(@CurrentUser() user: AuthUser, @Param('recurrenceId') recurrenceId: string) {
    return this.bookings.cancelRecurringSeries(user.id, recurrenceId);
  }

  @ApiBearerAuth()
  @RequirePerm('bookings.read')
  @Post(':id/reschedule')
  requestReschedule(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RequestRescheduleDto,
  ) {
    return this.bookings.requestReschedule(user.id, id, dto.date, dto.startMinutes);
  }

  // --- promo preview (before booking) ---
  @ApiBearerAuth()
  @RequirePerm('bookings.create')
  @Get('validate-promo')
  @ApiQuery({ name: 'code', required: true })
  @ApiQuery({ name: 'courtId', required: true })
  @ApiQuery({ name: 'slotCount', required: false })
  async validatePromo(
    @CurrentUser() user: AuthUser,
    @Query('code') code: string,
    @Query('courtId') courtId: string,
    @Query('slotCount') slotCount?: string,
  ) {
    const court = await this.courts.getActiveCourt(courtId);
    const n = Math.max(1, parseInt(slotCount ?? '1', 10));
    const amount = Number(court.pricePerHour) * ((court.slotMinutes * n) / 60);
    return this.promos.validatePromo(code, user.id, amount);
  }

  // --- group booking share links ---
  @ApiBearerAuth()
  @RequirePerm('bookings.read')
  @Post(':id/share')
  share(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bookings.shareBooking(user.id, id);
  }

  @Public()
  @Get('shared/:shareCode')
  getShared(@Param('shareCode') shareCode: string) {
    return this.bookings.getShared(shareCode);
  }

  @Public()
  @Post('shared/:shareCode/join')
  joinShared(@Param('shareCode') shareCode: string, @Body() dto: JoinSharedDto) {
    return this.bookings.joinShared(shareCode, dto);
  }
}
