import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public, RequirePerm } from '../common/auth';
import { AmenitiesService } from './amenities.service';
import { CreateAmenityDto, UpdateAmenityDto } from './dto';

@ApiTags('amenities')
@Controller('amenities')
export class AmenitiesController {
  constructor(private amenities: AmenitiesService) {}

  /** The active catalog — drives every amenity picker. */
  @Public()
  @Get()
  list() {
    return this.amenities.listActive();
  }
}

@ApiBearerAuth()
@ApiTags('admin · amenities')
@RequirePerm('*')
@Controller('admin/amenities')
export class AdminAmenitiesController {
  constructor(private amenities: AmenitiesService) {}

  @Get()
  list() {
    return this.amenities.listAll();
  }

  @Post()
  create(@Body() dto: CreateAmenityDto) {
    return this.amenities.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAmenityDto) {
    return this.amenities.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.amenities.remove(id);
  }
}
