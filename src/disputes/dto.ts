import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateDisputeDto {
  @ApiProperty({ example: 'clx...' })
  @IsString()
  bookingId: string;

  @ApiProperty({ example: 'The turf was locked when we arrived' })
  @IsString()
  reason: string;
}
