import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSION_LIST } from '../common/permissions';
import { AuthUser, CurrentUser, RequirePerm } from '../common/auth';
import { AdminService } from './admin.service';
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
} from './dto';
import { CreateBadgeDto, UpdateBadgeDto } from '../badges/dto';

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
  overview() {
    return this.analytics.overview();
  }

  @ApiTags('admin · analytics')
  @Get('analytics/trends')
  trends(@Query() q: AnalyticsQueryDto) {
    return this.analytics.trends(q.days, q.granularity);
  }

  @ApiTags('admin · analytics')
  @Get('analytics/breakdown')
  breakdown() {
    return this.analytics.breakdown();
  }

  @ApiTags('admin · analytics')
  @Get('analytics/venues')
  venueLeaderboard() {
    return this.analytics.venueLeaderboard();
  }

  @ApiTags('admin · analytics')
  @Get('analytics/venues/:id')
  venueDetail(@Param('id') id: string) {
    return this.analytics.venueDetail(id);
  }

  @ApiTags('admin · analytics')
  @Get('analytics/owners/:id')
  ownerDetail(@Param('id') id: string) {
    return this.analytics.ownerDetail(id);
  }

  @ApiTags('admin · analytics')
  @Get('analytics/users/:id')
  userDetail(@Param('id') id: string) {
    return this.analytics.userDetail(id);
  }

  // ------------------------------------------------------------------- users
  @ApiTags('admin · users')
  @Get('users')
  listUsers(@Query('q') q?: string, @Query('role') role?: string, @Query('status') status?: string) {
    return this.admin.listUsers(q, role, status);
  }

  @ApiTags('admin · users')
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
  @Post('users/:id/reset-strikes')
  resetStrikes(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.resetStrikes(u.id, id);
  }

  @ApiTags('admin · approvals')
  @Get('owners/pending')
  pendingOwners() {
    return this.admin.pendingOwners();
  }

  // ------------------------------------------------------------------- roles
  @ApiTags('admin · roles & permissions')
  @Get('roles')
  listRoles() {
    return this.admin.listRoles();
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
  @Delete('roles/:id')
  deleteRole(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.deleteRole(u.id, id);
  }

  // ------------------------------------------------------------------ venues
  @ApiTags('admin · approvals')
  @Get('venues/pending')
  pendingVenues() {
    return this.admin.pendingVenues();
  }

  @ApiTags('admin · approvals')
  @Post('venues/:id/approve')
  approveVenue(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.approveVenue(u.id, id);
  }

  @ApiTags('admin · approvals')
  @Post('venues/:id/reject')
  rejectVenue(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.rejectVenue(u.id, id);
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

  // ------------------------------------------------------------------ promos
  @ApiTags('admin · promos')
  @Get('promos')
  listPromos() {
    return this.admin.listPromos();
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

  // ------------------------------------------------------------------ badges
  @ApiTags('admin · badges')
  @Get('badges')
  listBadges() {
    return this.admin.listBadges();
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

  // ---------------------------------------------------------------- disputes
  @ApiTags('admin · disputes')
  @Get('disputes')
  listDisputes(@Query('status') status?: string) {
    return this.admin.listDisputes(status);
  }

  @ApiTags('admin · disputes')
  @Post('disputes/:id/resolve')
  resolveDispute(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ResolveDisputeDto) {
    return this.admin.resolveDispute(u.id, id, dto.action, dto.resolution);
  }

  // ------------------------------------------------------------------- audit
  @ApiTags('admin · audit logs')
  @Get('audit-logs')
  auditLogs(@Query('entity') entity?: string) {
    return this.admin.auditLogs(entity);
  }

  // --------------------------------------------------------------- broadcast
  @ApiTags('admin · broadcasts & banners')
  @Post('broadcasts')
  sendBroadcast(@CurrentUser() u: AuthUser, @Body() dto: SendBroadcastDto) {
    return this.admin.sendBroadcast(u.id, dto.title, dto.body, dto.city);
  }

  @ApiTags('admin · broadcasts & banners')
  @Get('banners')
  listBanners() {
    return this.admin.listBanners();
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
  listSuggestions(@Query('status') status?: string) {
    return this.admin.listSuggestions(status);
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
  getSettings() {
    return this.admin.getSettings();
  }

  @ApiTags('admin · settings')
  @Patch('settings')
  updateSettings(@CurrentUser() u: AuthUser, @Body() dto: UpdateSettingsDto) {
    return this.admin.updateSettings(u.id, dto.settings);
  }
}
