import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { PERMISSION_LIST } from '../common/permissions';
import { AuthUser, CurrentUser, RequirePerm } from '../common/auth';
import { AdminService } from './admin.service';
import { CursorQueryDto, OffsetQueryDto, offsetPage, pageLimit, wrapList } from '../common/pagination';
import { AnalyticsService } from './analytics.service';
import {
  AnalyticsQueryDto,
  CreateBannerDto,
  CreatePromoDto,
  CreateRoleDto,
  CreateUserDto,
  ResolveDisputeDto,
  SendBroadcastDto,
  SetStaffRolesDto,
  SetSuggestionStatusDto,
  SetUserRoleDto,
  SetUserStatusDto,
  UpdateBannerDto,
  UpdatePromoDto,
  UpdateRoleDto,
  UpdateSettingsDto,
  OnboardArenaDto,
  AdminUpdateVenueDto,
  AdminCreateCourtDto,
  AdminUpdateCourtDto,
  SetCourtLimitDto,
  SetStaffLimitDto,
  ResetPasswordDto,
} from './dto';
import { CreateBadgeDto, UpdateBadgeDto } from '../badges/dto';
import { PLAN_FEATURES } from '../plans/plans.service';
import { AssignPlanDto, CreatePlanDto, ExtendFreeDto, UpdatePlanDto } from '../plans/dto';

@ApiBearerAuth()
@RequirePerm('*') // super admin only — the whole panel lives behind this
@Controller('admin')
export class AdminController {
  constructor(
    private admin: AdminService,
    private analytics: AnalyticsService,
  ) {}

  // ---------------------------------------------------------------- analytics
  @ApiTags('admin · analytics')
  @Get('analytics/overview')
  overview(@Query() q: AnalyticsQueryDto) {
    return this.analytics.overview({ from: q.from, to: q.to });
  }

  @ApiTags('admin · analytics')
  @Get('analytics/trends')
  trends(@Query() q: AnalyticsQueryDto) {
    return this.analytics.trends(q.days, q.granularity, { from: q.from, to: q.to });
  }

  @ApiTags('admin · analytics')
  @Get('analytics/breakdown')
  breakdown(@Query() q: AnalyticsQueryDto) {
    return this.analytics.breakdown({ from: q.from, to: q.to });
  }

  @ApiTags('admin · analytics')
  @Get('analytics/venues')
  async venueLeaderboard(
    @Query() query: OffsetQueryDto,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return offsetPage(
      await this.analytics.venueLeaderboard({ from, to }),
      query.page ?? 1,
      pageLimit(query.limit, 50),
    );
  }

  @ApiTags('admin · analytics')
  @Get('analytics/venues/:id')
  venueDetail(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.venueDetail(id, { from, to });
  }

  @ApiTags('admin · analytics')
  @Get('analytics/owners/:id')
  ownerDetail(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.ownerDetail(id, { from, to });
  }

  @ApiTags('admin · analytics')
  @Get('analytics/users/:id')
  userDetail(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.userDetail(id, { from, to });
  }

  // ------------------------------------------------------------------- users
  @ApiTags('admin · users')
  @Get('users')
  listUsers(@Query('q') q?: string, @Query('role') role?: string, @Query('status') status?: string, @Query('cursor') cursor?: string) {
    return this.admin.listUsers(q, role, status, cursor);
  }

  @ApiTags('admin · users')
  @Get('users/stats')
  usersStats() {
    return this.admin.usersStats();
  }

  @ApiTags('admin · users')
  @Get('users/:id/profile')
  userProfile(@Param('id') id: string) {
    return this.admin.userDetailScreen(id);
  }

  @Get('users/:id')
  getUser(@Param('id') id: string) {
    return this.admin.getUser(id);
  }

  @ApiTags('admin · users')
  @Post('users')
  createUser(@CurrentUser() u: AuthUser, @Body() dto: CreateUserDto) {
    return this.admin.createUser(u.id, dto);
  }

  @ApiTags('admin · users')
  @Patch('users/:id/role')
  setUserRole(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SetUserRoleDto) {
    return this.admin.setUserRole(u.id, id, dto.roleId);
  }

  @ApiTags('admin · users')
  @Patch('users/:id/status')
  setUserStatus(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SetUserStatusDto) {
    return this.admin.setUserStatus(u.id, id, dto.status);
  }

  @ApiTags('admin · users')
  @Post('users/:id/reject')
  rejectUser(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body?: { reason?: string }) {
    return this.admin.rejectUser(u.id, id, body?.reason);
  }

  @ApiTags('admin · users')
  @Post('users/:id/reset-password')
  resetUserPassword(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ResetPasswordDto) {
    return this.admin.resetUserPassword(u.id, id, dto.newPassword);
  }

  @ApiTags('admin · users')
  @Post('users/:id/reset-strikes')
  resetStrikes(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.resetStrikes(u.id, id);
  }

  @ApiTags('admin · approvals')
  @Get('owners/pending')
  pendingOwners(@Query('cursor') cursor?: string) {
    return this.admin.pendingOwners(cursor);
  }

  @ApiTags('admin · users')
  @Get('owners/:id')
  ownerProfile(@Param('id') id: string) {
    return this.admin.ownerDetail(id);
  }

  // ------------------------------------------------------------------- roles
  @ApiTags('admin · roles & permissions')
  @Get('roles')
  async listRoles(@Query('scope') scope?: string) {
    return wrapList(await this.admin.listRoles(scope === 'system'));
  }

  @ApiTags('admin · roles & permissions')
  @Get('permissions')
  permissionCatalog() {
    return PERMISSION_LIST;
  }

  @ApiTags('admin · roles & permissions')
  @Post('roles')
  createRole(@CurrentUser() u: AuthUser, @Body() dto: CreateRoleDto) {
    return this.admin.createRole(u.id, dto);
  }

  @ApiTags('admin · roles & permissions')
  @Patch('roles/:id')
  updateRole(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.admin.updateRole(u.id, id, dto);
  }

  @ApiTags('admin · roles & permissions')
  @Patch('roles/:id/active')
  setRoleActive(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() body: { isActive: boolean },
  ) {
    return this.admin.setRoleActive(u.id, id, body.isActive);
  }

  @ApiTags('admin · roles & permissions')
  @Delete('roles/:id')
  deleteRole(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.deleteRole(u.id, id);
  }

  // ------------------------------------------------------------------ venues
  @ApiTags('admin · approvals')
  @Get('venues/pending')
  pendingVenues(@Query('cursor') cursor?: string) {
    return this.admin.pendingVenues(cursor);
  }

  @ApiTags('admin · approvals')
  @Post('venues/:id/approve')
  approveVenue(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.approveVenue(u.id, id);
  }

  @ApiTags('admin · approvals')
  @Post('venues/:id/reject')
  rejectVenue(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body?: { reason?: string }) {
    return this.admin.rejectVenue(u.id, id, body?.reason);
  }

  @ApiTags('admin · approvals')
  @Post('venues/:id/suspend')
  suspendVenue(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.suspendVenue(u.id, id);
  }

  @ApiTags('admin · approvals')
  @Patch('venues/:id/staff-roles')
  setVenueStaffRoles(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SetStaffRolesDto) {
    return this.admin.setVenueStaffRoles(u.id, id, dto.roleIds);
  }

  // ------------------------------------------------- venues & onboarding
  // These three routes relax the class-level '*' to the venues.onboard
  // permission: the super admin (wildcard) always passes, and any role
  // granted venues.onboard in the Roles page can onboard arenas too.
  @ApiTags('admin · venues')
  @RequirePerm('venues.onboard')
  @Get('venues')
  listVenuesAdmin(
    @CurrentUser() u: AuthUser,
    @Query('sort') sort?: string,
    @Query('range') range?: string,
    @Query('status') status?: string,
    @Query() query?: OffsetQueryDto,
  ) {
    return this.admin.listVenuesAdmin({
      sort,
      range,
      status,
      page: query?.page,
      limit: query?.limit,
      // Delegated operators see operations, not owner contact,
      // billing state, or money figures.
      stripSensitive: !u.permissions.includes('*'),
    });
  }

  @ApiTags('admin · venues')
  @RequirePerm('venues.onboard')
  @Post('venues/onboard')
  onboardArena(@CurrentUser() u: AuthUser, @Body() dto: OnboardArenaDto) {
    return this.admin.onboardArena(u.id, dto);
  }

  @ApiTags('admin · venues')
  @RequirePerm('venues.onboard')
  @ApiTags('admin · venues')
  @Get('venues/:id/series')
  venueSeries(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.admin.venueSeries(
      id,
      days ? parseInt(days, 10) : 30,
      {
        from,
        to,
      },
      !u.permissions.includes('*'),
    );
  }

  @ApiTags('admin · venues')
  @RequirePerm('venues.onboard')
  @Get('venues/:id')
  venueDetailAdmin(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.venueDetailAdmin(id, {
      stripSensitive: !u.permissions.includes('*'),
    });
  }

  @ApiTags('admin · venues')
  @Post('venues/:id/court-limit')
  setCourtLimit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetCourtLimitDto,
  ) {
    return this.admin.setCourtLimit(user.id, id, dto.limit ?? null, dto.confirmBelowUsage ?? false);
  }

  @ApiTags('admin · venues')
  @Post('venues/:id/staff-limit')
  setStaffLimit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetStaffLimitDto,
  ) {
    return this.admin.setStaffLimit(user.id, id, dto.limit ?? null, dto.confirmBelowUsage ?? false);
  }

  @ApiTags('admin · venues')
  @Patch('venues/:id')
  updateVenue(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AdminUpdateVenueDto,
  ) {
    return this.admin.updateVenue(user.id, id, dto);
  }

  @ApiTags('admin · venues')
  @RequirePerm('venues.onboard')
  @Post('venues/:id/images')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('image'))
  addVenueImage(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('sport') sport?: string,
  ) {
    return this.admin.addVenueImage(id, file, sport, u);
  }

  @ApiTags('admin · venues')
  @RequirePerm('venues.onboard')
  @Patch('venues/:id/images/order')
  reorderVenueImages(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() body: { urls?: string[] },
  ) {
    return this.admin.reorderVenueImages(id, body?.urls ?? [], u);
  }

  @ApiTags('admin · venues')
  @RequirePerm('venues.onboard')
  @Get('venues/onboard/check')
  onboardCheck(
    @CurrentUser() u: AuthUser,
    @Query('phone') phone?: string,
    @Query('name') name?: string,
    @Query('city') city?: string,
  ) {
    return this.admin.onboardDuplicateCheck(
      { phone, name, city },
      !u.permissions.includes('*'),
    );
  }

  @ApiTags('admin · venues')
  @RequirePerm('venues.onboard')
  @Patch('venues/:id/images/tag')
  tagVenueImage(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body('url') url: string,
    @Body('sport') sport: string | null,
  ) {
    return this.admin.tagVenueImage(id, url, sport ?? null, u);
  }

  @ApiTags('admin · venues')
  @Post('venues/:id/moderation')
  setVenueModeration(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: { status: string; reason?: string },
  ) {
    return this.admin.setVenueModeration(u.id, id, dto);
  }

  @ApiTags('admin · venues')
  @Get('courts/pending')
  pendingCourts(@Query('cursor') cursor?: string) {
    return this.admin.pendingCourts(cursor);
  }

  @ApiTags('admin · venues')
  @Post('courts/:id/approve')
  approveCourt(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.approveCourt(u.id, id);
  }

  @ApiTags('admin · venues')
  @Post('courts/:id/reject')
  rejectCourt(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() body?: { note?: string; reason?: string },
  ) {
    return this.admin.rejectCourt(u.id, id, body?.reason ?? body?.note);
  }

  @ApiTags('admin · venues')
  @RequirePerm('venues.onboard')
  @Delete('venues/:id/images')
  removeVenueImage(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body('url') url: string) {
    return this.admin.removeVenueImage(id, url, u);
  }

  @ApiTags('admin · venues')
  @Post('venues/:venueId/courts')
  createCourt(
    @CurrentUser() user: AuthUser,
    @Param('venueId') venueId: string,
    @Body() dto: AdminCreateCourtDto,
  ) {
    return this.admin.createCourt(user.id, venueId, dto);
  }

  @ApiTags('admin · venues')
  @ApiTags('admin · venues')
  @Get('courts/:id/detail')
  courtDetail(
    @Param('id') id: string,
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.admin.courtDetailAdmin(id, days ? parseInt(days, 10) : 30, {
      from,
      to,
    });
  }

  @Patch('courts/:id')
  updateCourt(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AdminUpdateCourtDto,
  ) {
    return this.admin.updateCourt(user.id, id, dto);
  }

  @ApiTags('admin · venues')
  @Delete('courts/:id')
  deleteCourt(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.deleteCourt(user.id, id);
  }

  @ApiTags('admin · venues')
  @Post('courts/:id/images')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('image'))
  addCourtImage(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    return this.admin.addCourtImage(id, file);
  }

  @ApiTags('admin · venues')
  @Delete('courts/:id/images')
  removeCourtImage(@Param('id') id: string, @Body('url') url: string) {
    return this.admin.removeCourtImage(id, url);
  }

  // ------------------------------------------------------------------ promos
  @ApiTags('admin · promos')
  @Get('promos')
  listPromos(@Query() query: CursorQueryDto, @Query('q') q?: string) {
    return this.admin.listPromos(query.cursor, query.limit, q);
  }

  @ApiTags('admin · promos')
  @Post('promos')
  createPromo(@CurrentUser() u: AuthUser, @Body() dto: CreatePromoDto) {
    return this.admin.createPromo(u.id, dto);
  }

  @ApiTags('admin · promos')
  @Patch('promos/:id')
  updatePromo(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdatePromoDto) {
    return this.admin.updatePromo(u.id, id, dto);
  }

  // ------------------------------------------------------------------ plans
  @ApiTags('admin · plans')
  @Get('plans/features')
  planFeatures() {
    return PLAN_FEATURES;
  }

  @ApiTags('admin · plans')
  @RequirePerm('venues.onboard')
  @Get('plans')
  async listPlans() {
    return wrapList(await this.admin.listPlans());
  }

  @ApiTags('admin · plans')
  @Post('plans')
  createPlan(@CurrentUser() u: AuthUser, @Body() dto: CreatePlanDto) {
    return this.admin.createPlan(u.id, dto);
  }

  @ApiTags('admin · plans')
  @Patch('plans/:id')
  updatePlan(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.admin.updatePlan(u.id, id, dto);
  }

  @ApiTags('admin · plans')
  @Delete('plans/:id')
  deletePlan(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.deletePlan(u.id, id);
  }

  @ApiTags('admin · plans')
  @Get('plans/venues')
  listVenueBilling(@Query('status') status?: string, @Query() query?: OffsetQueryDto) {
    return this.admin.listVenueBilling(query?.page ?? 1, query?.limit, status);
  }

  @ApiTags('admin · plans')
  @Get('venues/:id/billing')
  venueBilling(@Param('id') id: string) {
    return this.admin.venueBilling(id);
  }

  @ApiTags('admin · plans')
  @Post('venues/:id/plan')
  assignVenuePlan(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AssignPlanDto) {
    return this.admin.assignVenuePlan(u.id, id, dto.planId, dto.restartBilling ?? false, dto.confirmBelowUsage ?? false);
  }

  @ApiTags('admin · plans')
  @Post('venues/:id/billing/extend-free')
  extendVenueFree(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ExtendFreeDto) {
    return this.admin.extendVenueFree(u.id, id, dto.months);
  }

  @ApiTags('admin · plans')
  @Post('venues/:id/billing/mark-paid')
  markVenuePaid(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() body?: { method?: string; note?: string; amount?: number },
  ) {
    return this.admin.markVenuePaid(u.id, id, body);
  }

  @ApiTags('admin · plans')
  @Post('venues/:id/billing/:paymentId/void')
  voidVenuePayment(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
  ) {
    return this.admin.voidVenuePayment(u.id, id, paymentId);
  }

  // ------------------------------------------------------------------ badges
  @ApiTags('admin · badges')
  @Get('badges')
  async listBadges() {
    return wrapList(await this.admin.listBadges());
  }

  @ApiTags('admin · badges')
  @Post('badges')
  createBadge(@CurrentUser() u: AuthUser, @Body() dto: CreateBadgeDto) {
    return this.admin.createBadge(u.id, dto);
  }

  @ApiTags('admin · badges')
  @Patch('badges/:id')
  updateBadge(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateBadgeDto) {
    return this.admin.updateBadge(u.id, id, dto);
  }

  @ApiTags('admin · badges')
  @Delete('badges/:id')
  deleteBadge(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.deleteBadge(u.id, id);
  }

  @ApiTags('admin · badges')
  @Post('venues/:id/badges')
  grantVenueBadge(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body('badgeId') badgeId: string) {
    return this.admin.grantVenueBadge(u.id, id, badgeId);
  }

  @ApiTags('admin · badges')
  @Delete('venues/:id/badges/:badgeId')
  revokeVenueBadge(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('badgeId') badgeId: string) {
    return this.admin.revokeVenueBadge(u.id, id, badgeId);
  }

  @ApiTags('admin · venues')
  @Post('venues/:id/unsuspend')
  unsuspendVenue(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.unsuspendVenue(u.id, id);
  }

  @ApiTags('admin · venues')
  @Post('venues/:id/requeue')
  requeueVenue(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.requeueVenue(u.id, id);
  }

  @ApiTags('admin · venues')
  @Post('courts/:id/requeue')
  requeueCourt(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.requeueCourt(u.id, id);
  }

  // ---------------------------------------------------------------- disputes
  @ApiTags('admin · venues')
  @Get('venue-reports')
  listVenueReports(
    @Query('status') status?: string,
    @Query('venueId') venueId?: string,
    @Query() query?: OffsetQueryDto,
  ) {
    return this.admin.listVenueReports({
      status,
      venueId,
      page: query?.page ?? 1,
      limit: query?.limit,
    });
  }

  @ApiTags('admin · venues')
  @Post('venue-reports/:id/resolve')
  resolveVenueReport(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { status: string; resolution?: string },
  ) {
    return this.admin.resolveVenueReport(user.id, id, body ?? { status: '' });
  }

  @ApiTags('admin · disputes')
  @Get('disputes')
  listDisputes(@Query('status') status?: string, @Query('q') q?: string, @Query() query?: CursorQueryDto) {
    return this.admin.listDisputes(status, query?.cursor, query?.limit, q);
  }

  @ApiTags('admin · disputes')
  @Post('disputes/:id/resolve')
  resolveDispute(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ResolveDisputeDto) {
    return this.admin.resolveDispute(u.id, id, dto.action, dto.resolution);
  }

  // ------------------------------------------------------------------- audit
  @ApiTags('admin · audit logs')
  @Get('audit-logs')
  auditLogs(
    @Query('entity') entity?: string,
    @Query() query?: OffsetQueryDto,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.admin.auditLogs(entity, query?.page ?? 1, query?.limit, from, to);
  }

  // --------------------------------------------------------------- broadcast
  @ApiTags('admin · broadcasts & banners')
  @Post('broadcasts')
  sendBroadcast(@CurrentUser() u: AuthUser, @Body() dto: SendBroadcastDto) {
    return this.admin.sendBroadcast(u.id, dto.title, dto.body, dto.city);
  }

  @ApiTags('admin · broadcasts & banners')
  @Get('broadcasts/history')
  broadcastHistory(@Query() query: CursorQueryDto) {
    return this.admin.broadcastHistory(query.cursor, query.limit);
  }

  @ApiTags('admin · broadcasts & banners')
  @Get('broadcasts/audience')
  broadcastAudience(@Query('city') city?: string) {
    return this.admin.broadcastAudience(city);
  }

  @ApiTags('admin · broadcasts & banners')
  @Get('banners')
  async listBanners() {
    return wrapList(await this.admin.listBanners());
  }

  @ApiTags('admin · broadcasts & banners')
  @Post('banners/upload')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('image'))
  uploadBannerImage(@UploadedFile() file: Express.Multer.File) {
    return this.admin.uploadBannerImage(file);
  }

  @ApiTags('admin · broadcasts & banners')
  @Post('banners')
  createBanner(@CurrentUser() u: AuthUser, @Body() dto: CreateBannerDto) {
    return this.admin.createBanner(u.id, dto);
  }

  @ApiTags('admin · broadcasts & banners')
  @Patch('banners/:id')
  updateBanner(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateBannerDto) {
    return this.admin.updateBanner(u.id, id, dto);
  }

  @ApiTags('admin · broadcasts & banners')
  @Delete('banners/:id')
  deleteBanner(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.deleteBanner(u.id, id);
  }

  // -------------------------------------------------------------- suggestions
  @ApiTags('admin · suggestions')
  @Get('suggestions')
  async listSuggestions(@Query('status') status?: string) {
    return wrapList(await this.admin.listSuggestions(status));
  }

  @ApiTags('admin · suggestions')
  @Patch('suggestions/:id')
  setSuggestionStatus(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SetSuggestionStatusDto) {
    return this.admin.setSuggestionStatus(u.id, id, dto.status);
  }

  // --------------------------------------------------------------- game posts
  @ApiTags('admin · game curation')
  @Patch('game-posts/:id/curate')
  curateGamePost(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.curateGamePost(u.id, id);
  }

  @ApiTags('admin · game curation')
  @Patch('game-posts/:id/uncurate')
  uncurateGamePost(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.uncurateGamePost(u.id, id);
  }

  @ApiTags('admin · game curation')
  @Delete('game-posts/:id')
  deleteGamePost(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.deleteGamePost(u.id, id);
  }

  @ApiTags('admin · moderation')
  @Delete('reviews/:id')
  deleteReview(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.deleteReview(u.id, id);
  }

  // ------------------------------------------------------- booking interventions
  @ApiTags('admin · booking support')
  @Get('bookings/:id')
  getBooking(@Param('id') id: string) {
    return this.admin.getBooking(id);
  }

  @ApiTags('admin · booking support')
  @Post('bookings/:id/cancel')
  cancelBooking(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.cancelBooking(u.id, id);
  }

  @ApiTags('admin · booking support')
  @Post('bookings/:id/force-confirm')
  forceConfirmBooking(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.forceConfirmBooking(u.id, id);
  }

  // ---------------------------------------------------------------- settings
  @ApiTags('admin · settings')
  @Get('settings')
  async getSettings() {
    return wrapList(await this.admin.getSettings());
  }

  @ApiTags('admin · settings')
  @Patch('settings')
  async updateSettings(@CurrentUser() u: AuthUser, @Body() dto: UpdateSettingsDto) {
    return wrapList(await this.admin.updateSettings(u.id, dto.settings));
  }
}
