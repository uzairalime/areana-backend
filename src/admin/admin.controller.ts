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

@ApiTags('admin')
@ApiBearerAuth()
@RequirePerm('*') // super admin only — the whole panel lives behind this
@Controller('admin')
export class AdminController {
  constructor(
    private admin: AdminService,
    private analytics: AnalyticsService,
  ) {}

  // ---------------------------------------------------------------- analytics
  @Get('analytics/overview')
  overview() {
    return this.analytics.overview();
  }

  @Get('analytics/trends')
  trends(@Query() q: AnalyticsQueryDto) {
    return this.analytics.trends(q.days, q.granularity);
  }

  @Get('analytics/breakdown')
  breakdown() {
    return this.analytics.breakdown();
  }

  @Get('analytics/venues')
  venueLeaderboard() {
    return this.analytics.venueLeaderboard();
  }

  @Get('analytics/venues/:id')
  venueDetail(@Param('id') id: string) {
    return this.analytics.venueDetail(id);
  }

  @Get('analytics/owners/:id')
  ownerDetail(@Param('id') id: string) {
    return this.analytics.ownerDetail(id);
  }

  @Get('analytics/users/:id')
  userDetail(@Param('id') id: string) {
    return this.analytics.userDetail(id);
  }

  // ------------------------------------------------------------------- users
  @Get('users')
  listUsers(@Query('q') q?: string, @Query('role') role?: string, @Query('status') status?: string) {
    return this.admin.listUsers(q, role, status);
  }

  @Get('users/:id')
  getUser(@Param('id') id: string) {
    return this.admin.getUser(id);
  }

  @Post('users')
  createUser(@CurrentUser() u: AuthUser, @Body() dto: CreateUserDto) {
    return this.admin.createUser(u.id, dto);
  }

  @Patch('users/:id/role')
  setUserRole(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SetUserRoleDto) {
    return this.admin.setUserRole(u.id, id, dto.roleId);
  }

  @Patch('users/:id/status')
  setUserStatus(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SetUserStatusDto) {
    return this.admin.setUserStatus(u.id, id, dto.status);
  }

  @Post('users/:id/reset-strikes')
  resetStrikes(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.resetStrikes(u.id, id);
  }

  @Get('owners/pending')
  pendingOwners() {
    return this.admin.pendingOwners();
  }

  // ------------------------------------------------------------------- roles
  @Get('roles')
  listRoles() {
    return this.admin.listRoles();
  }

  @Get('permissions')
  permissionCatalog() {
    return PERMISSION_LIST;
  }

  @Post('roles')
  createRole(@CurrentUser() u: AuthUser, @Body() dto: CreateRoleDto) {
    return this.admin.createRole(u.id, dto);
  }

  @Patch('roles/:id')
  updateRole(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.admin.updateRole(u.id, id, dto);
  }

  @Delete('roles/:id')
  deleteRole(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.deleteRole(u.id, id);
  }

  // ------------------------------------------------------------------ venues
  @Get('venues/pending')
  pendingVenues() {
    return this.admin.pendingVenues();
  }

  @Post('venues/:id/approve')
  approveVenue(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.approveVenue(u.id, id);
  }

  @Post('venues/:id/reject')
  rejectVenue(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.rejectVenue(u.id, id);
  }

  @Post('venues/:id/suspend')
  suspendVenue(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.suspendVenue(u.id, id);
  }

  @Patch('venues/:id/staff-roles')
  setVenueStaffRoles(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SetStaffRolesDto) {
    return this.admin.setVenueStaffRoles(u.id, id, dto.roleIds);
  }

  // ------------------------------------------------------------------ promos
  @Get('promos')
  listPromos() {
    return this.admin.listPromos();
  }

  @Post('promos')
  createPromo(@CurrentUser() u: AuthUser, @Body() dto: CreatePromoDto) {
    return this.admin.createPromo(u.id, dto);
  }

  @Patch('promos/:id')
  updatePromo(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdatePromoDto) {
    return this.admin.updatePromo(u.id, id, dto);
  }

  // ------------------------------------------------------------------ badges
  @Get('badges')
  listBadges() {
    return this.admin.listBadges();
  }

  @Post('badges')
  createBadge(@CurrentUser() u: AuthUser, @Body() dto: CreateBadgeDto) {
    return this.admin.createBadge(u.id, dto);
  }

  @Patch('badges/:id')
  updateBadge(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateBadgeDto) {
    return this.admin.updateBadge(u.id, id, dto);
  }

  @Delete('badges/:id')
  deleteBadge(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.deleteBadge(u.id, id);
  }

  @Post('venues/:id/badges')
  grantVenueBadge(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body('badgeId') badgeId: string) {
    return this.admin.grantVenueBadge(u.id, id, badgeId);
  }

  @Delete('venues/:id/badges/:badgeId')
  revokeVenueBadge(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('badgeId') badgeId: string) {
    return this.admin.revokeVenueBadge(u.id, id, badgeId);
  }

  // ---------------------------------------------------------------- disputes
  @Get('disputes')
  listDisputes(@Query('status') status?: string) {
    return this.admin.listDisputes(status);
  }

  @Post('disputes/:id/resolve')
  resolveDispute(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ResolveDisputeDto) {
    return this.admin.resolveDispute(u.id, id, dto.action, dto.resolution);
  }

  // ------------------------------------------------------------------- audit
  @Get('audit-logs')
  auditLogs(@Query('entity') entity?: string) {
    return this.admin.auditLogs(entity);
  }

  // --------------------------------------------------------------- broadcast
  @Post('broadcasts')
  sendBroadcast(@CurrentUser() u: AuthUser, @Body() dto: SendBroadcastDto) {
    return this.admin.sendBroadcast(u.id, dto.title, dto.body, dto.city);
  }

  @Get('banners')
  listBanners() {
    return this.admin.listBanners();
  }

  @Post('banners')
  createBanner(@CurrentUser() u: AuthUser, @Body() dto: CreateBannerDto) {
    return this.admin.createBanner(u.id, dto);
  }

  @Patch('banners/:id')
  updateBanner(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateBannerDto) {
    return this.admin.updateBanner(u.id, id, dto);
  }

  @Delete('banners/:id')
  deleteBanner(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.deleteBanner(u.id, id);
  }

  // -------------------------------------------------------------- suggestions
  @Get('suggestions')
  listSuggestions(@Query('status') status?: string) {
    return this.admin.listSuggestions(status);
  }

  @Patch('suggestions/:id')
  setSuggestionStatus(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SetSuggestionStatusDto) {
    return this.admin.setSuggestionStatus(u.id, id, dto.status);
  }

  // --------------------------------------------------------------- game posts
  @Patch('game-posts/:id/curate')
  curateGamePost(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.curateGamePost(u.id, id);
  }

  @Patch('game-posts/:id/uncurate')
  uncurateGamePost(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.uncurateGamePost(u.id, id);
  }

  @Delete('game-posts/:id')
  deleteGamePost(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.deleteGamePost(u.id, id);
  }

  @Delete('reviews/:id')
  deleteReview(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.deleteReview(u.id, id);
  }

  // ------------------------------------------------------- booking interventions
  @Get('bookings/:id')
  getBooking(@Param('id') id: string) {
    return this.admin.getBooking(id);
  }

  @Post('bookings/:id/cancel')
  cancelBooking(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.cancelBooking(u.id, id);
  }

  @Post('bookings/:id/force-confirm')
  forceConfirmBooking(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.admin.forceConfirmBooking(u.id, id);
  }

  // ---------------------------------------------------------------- settings
  @Get('settings')
  getSettings() {
    return this.admin.getSettings();
  }

  @Patch('settings')
  updateSettings(@CurrentUser() u: AuthUser, @Body() dto: UpdateSettingsDto) {
    return this.admin.updateSettings(u.id, dto.settings);
  }
}
