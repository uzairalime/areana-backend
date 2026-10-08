import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class FavoriteVenueDto {
  @ApiProperty({ example: 'clx...' })
  @IsString()
  venueId: string;
}
