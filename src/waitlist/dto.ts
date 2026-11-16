import { IsInt, IsString, Matches, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class JoinWaitlistDto {
  @ApiProperty()
  @IsString()
  courtId: string;

  @ApiProperty({ example: '2026-10-20' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiProperty({ example: 1080 })
  @IsInt()
  @Min(0)
  startMinutes: number;
}
