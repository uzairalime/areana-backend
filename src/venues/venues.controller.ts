import { Body, Controller, Get, Ip, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public, type AuthUser } from '../common/auth';
import { VenuesService } from './venues.service';
import { wrapList } from '../common/pagination';
import { QueryVenuesDto, ReportVenueDto } from './dto';

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
  async cities() {
    return wrapList(await this.venues.cities());
  }

  /** Distinct court surfaces across approved venues (for filter dropdowns). */
  @Public()
  @Get('surfaces')
  async surfaces() {
    return wrapList(await this.venues.surfaces());
  }

  @Public()
  @Get(':id')
  getById(@Param('id') id: string) {
    return this.venues.getById(id);
  }

  /** Report this arena (signed-in players only). */
  @Post(':id/report')
  report(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReportVenueDto,
  ) {
    return this.venues.reportVenue(user.id, id, dto);
  }

  /** The signed-in player's own latest report for this arena, if any. */
  @Get(':id/report/me')
  myReport(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.venues.myVenueReport(user.id, id);
  }

  /** View / click beacon from the player web (fire-and-forget). */
  @Public()
  @Post(':id/events')
  recordEvent(
    @Param('id') id: string,
    @Body() body: { type?: string; courtId?: string; visitorId?: string },
    @CurrentUser() user: AuthUser | undefined,
    @Ip() ip: string,
  ) {
    return this.venues.recordEvent(id, body ?? {}, user, ip);
  }
}
