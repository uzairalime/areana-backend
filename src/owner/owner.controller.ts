import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequireAnyPerm, RequirePerm } from '../common/auth';
import { OwnerService } from './owner.service';
import {
  BookingsQueryDto,
  CheckInScanDto,
  CreateBlockDto,
  CreateCourtDto,
  CreateStaffDto,
  CreateVenueDto,
  RejectDto,
  ReplyReviewDto,
  UpdateCourtDto,
  UpdateVenueDto,
  WalkInDto,
} from './dto';

@ApiBearerAuth()
@Controller('owner')
export class OwnerController {
  constructor(private owner: OwnerService) {}

  // ------------------------------------------------------------- dashboard
  @ApiTags('owner · dashboard')
  @Get('dashboard')
  dashboard(
    @CurrentUser() user: AuthUser,
    @Query('venueId') venueId?: string,
    @Query('date') date?: string,
  ) {
    return this.owner.dashboard(user, venueId, date);
  }

  // ---------------------------------------------------------------- venues
  @ApiTags('owner · venues & courts')
  @Get('venues')
  myVenues(@CurrentUser() user: AuthUser) {
    return this.owner.listMyVenues(user);
  }

  @RequirePerm('venues.manage')
  @ApiTags('owner · venues & courts')
  @Post('venues')
  createVenue(@CurrentUser() user: AuthUser, @Body() dto: CreateVenueDto) {
    return this.owner.createVenue(user, dto);
  }

  @RequirePerm('venues.manage')
  @ApiTags('owner · venues & courts')
  @Patch('venues/:id')
  updateVenue(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateVenueDto) {
    return this.owner.updateVenue(user, id, dto);
  }

  @RequirePerm('venues.manage')
  @ApiTags('owner · venues & courts')
  @Post('venues/:id/submit')
  submitVenue(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.owner.submitVenue(user, id);
  }

  @RequirePerm('venues.manage')
  @ApiTags('owner · venues & courts')
  @Post('venues/:id/images')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('image'))
  addImage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.owner.addVenueImage(user, id, file);
  }

  @RequirePerm('venues.manage')
  @ApiTags('owner · venues & courts')
  @Delete('venues/:id/images')
  removeImage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body('url') url: string,
  ) {
    return this.owner.removeVenueImage(user, id, url);
  }

  // ---------------------------------------------------------------- courts
  @RequirePerm('courts.manage')
  @ApiTags('owner · venues & courts')
  @Get('venues/:venueId/courts')
  courts(@CurrentUser() user: AuthUser, @Param('venueId') venueId: string) {
    return this.owner.courts(user, venueId);
  }

  @RequirePerm('courts.manage')
  @ApiTags('owner · venues & courts')
  @Post('venues/:venueId/courts')
  createCourt(
    @CurrentUser() user: AuthUser,
    @Param('venueId') venueId: string,
    @Body() dto: CreateCourtDto,
  ) {
    return this.owner.createCourt(user, venueId, dto);
  }

  @RequirePerm('courts.manage')
  @ApiTags('owner · venues & courts')
  @Patch('courts/:id')
  updateCourt(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateCourtDto) {
    return this.owner.updateCourt(user, id, dto);
  }

  // ---------------------------------------------------------------- blocks
  @RequireAnyPerm('blocks.manage', 'schedule.manage')
  @ApiTags('owner · calendar blocks')
  @Get('venues/:venueId/blocks')
  blocks(
    @CurrentUser() user: AuthUser,
    @Param('venueId') venueId: string,
    @Query('date') date?: string,
  ) {
    return this.owner.blocks(user, venueId, date);
  }

  @RequireAnyPerm('blocks.manage', 'schedule.manage')
  @ApiTags('owner · calendar blocks')
  @Post('blocks')
  createBlock(@CurrentUser() user: AuthUser, @Body() dto: CreateBlockDto) {
    return this.owner.createBlock(user, dto);
  }

  @RequireAnyPerm('blocks.manage', 'schedule.manage')
  @ApiTags('owner · calendar blocks')
  @Delete('blocks/:id')
  deleteBlock(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.owner.deleteBlock(user, id);
  }

  // --------------------------------------------------------------- bookings
  @RequireAnyPerm('bookings.manage', 'bookings.review')
  @ApiTags('owner · bookings')
  @Get('bookings')
  bookings(@CurrentUser() user: AuthUser, @Query() query: BookingsQueryDto) {
    return this.owner.bookings(user, query);
  }

  @RequirePerm('bookings.review')
  @ApiTags('owner · bookings')
  @Patch('bookings/:id/accept')
  accept(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.owner.acceptBooking(user, id);
  }

  @RequirePerm('bookings.review')
  @ApiTags('owner · bookings')
  @Patch('bookings/:id/reject')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RejectDto) {
    return this.owner.rejectBooking(user, id, dto.reason);
  }

  @RequirePerm('bookings.review')
  @ApiTags('owner · bookings')
  @Post('bookings/recurring/:recurrenceId/accept')
  acceptSeries(
    @CurrentUser() user: AuthUser,
    @Param('recurrenceId') recurrenceId: string,
    @Body('venueId') venueId: string,
  ) {
    return this.owner.acceptSeries(user, recurrenceId, venueId);
  }

  @RequirePerm('bookings.manage')
  @ApiTags('owner · bookings')
  @Patch('bookings/:id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.owner.cancelBooking(user, id);
  }

  @RequirePerm('bookings.manage')
  @ApiTags('owner · bookings')
  @Post('bookings/walk-in')
  walkIn(@CurrentUser() user: AuthUser, @Body() dto: WalkInDto) {
    return this.owner.walkIn(user, dto);
  }

  @RequirePerm('bookings.manage')
  @ApiTags('owner · bookings')
  @Post('bookings/check-in-scan')
  checkInScan(@CurrentUser() user: AuthUser, @Body() dto: CheckInScanDto) {
    return this.owner.checkInScan(user, dto.venueId, dto.code);
  }

  @RequirePerm('bookings.manage')
  @ApiTags('owner · bookings')
  @Patch('bookings/:id/check-in')
  checkIn(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.owner.checkIn(user, id);
  }

  @RequirePerm('bookings.manage')
  @ApiTags('owner · bookings')
  @Patch('bookings/:id/no-show')
  noShow(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.owner.markNoShow(user, id);
  }

  // ------------------------------------------------------------- reschedules
  @RequireAnyPerm('bookings.manage', 'bookings.review')
  @ApiTags('owner · reschedules')
  @Get('reschedules')
  reschedules(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.owner.reschedules(user, status);
  }

  @RequirePerm('bookings.review')
  @ApiTags('owner · reschedules')
  @Patch('reschedules/:id/accept')
  acceptReschedule(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.owner.acceptReschedule(user, id);
  }

  @RequirePerm('bookings.review')
  @ApiTags('owner · reschedules')
  @Patch('reschedules/:id/reject')
  rejectReschedule(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RejectDto) {
    return this.owner.rejectReschedule(user, id, dto.reason);
  }

  // ------------------------------------------------------------------ staff
  @ApiTags('owner · staff')
  @Get('venues/:venueId/allowed-roles')
  allowedRoles(@CurrentUser() user: AuthUser, @Param('venueId') venueId: string) {
    return this.owner.allowedRoles(user, venueId);
  }

  @RequirePerm('staff.manage')
  @ApiTags('owner · staff')
  @Get('venues/:venueId/staff')
  staffList(@CurrentUser() user: AuthUser, @Param('venueId') venueId: string) {
    return this.owner.staffList(user, venueId);
  }

  @RequirePerm('staff.manage')
  @ApiTags('owner · staff')
  @Post('venues/:venueId/staff')
  createStaff(
    @CurrentUser() user: AuthUser,
    @Param('venueId') venueId: string,
    @Body() dto: CreateStaffDto,
  ) {
    return this.owner.createStaff(user, venueId, dto);
  }

  @RequirePerm('staff.manage')
  @ApiTags('owner · staff')
  @Delete('staff/:id')
  removeStaff(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.owner.removeStaff(user, id);
  }

  // --------------------------------------------------------------- customers
  @RequirePerm('customers.read')
  @ApiTags('owner · customers')
  @Get('customers')
  customers(@CurrentUser() user: AuthUser, @Query('venueId') venueId?: string) {
    return this.owner.customers(user, venueId);
  }

  // ---------------------------------------------------------------- reviews
  @RequirePerm('reviews.reply')
  @ApiTags('owner · reviews')
  @Get('reviews')
  reviews(@CurrentUser() user: AuthUser, @Query('venueId') venueId?: string) {
    return this.owner.reviews(user, venueId);
  }

  @RequirePerm('reviews.reply')
  @ApiTags('owner · reviews')
  @Post('reviews/:id/reply')
  replyReview(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReplyReviewDto) {
    return this.owner.replyReview(user, id, dto.reply);
  }
}
