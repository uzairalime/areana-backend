import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public, RequirePerm } from '../common/auth';
import { SportsService } from './sports.service';
import { CreateSportDto, UpdateSportDto } from './dto';

@ApiTags('sports')
@Controller('sports')
export class SportsController {
  constructor(private sports: SportsService) {}

  /** The active catalog — drives every sport picker and filter. */
  @Public()
  @Get()
  list() {
    return this.sports.listActive();
  }
}

@ApiBearerAuth()
@ApiTags('admin · sports')
@RequirePerm('*')
@Controller('admin/sports')
export class AdminSportsController {
  constructor(private sports: SportsService) {}

  @Get()
  list() {
    return this.sports.listAll();
  }

  @Post()
  create(@Body() dto: CreateSportDto) {
    return this.sports.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSportDto) {
    return this.sports.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.sports.remove(id);
  }
}
