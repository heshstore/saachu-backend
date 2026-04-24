import { IsString, IsOptional, IsNotEmpty } from 'class-validator';

export class TrackEventDto {
  @IsString()
  @IsNotEmpty()
  session_id: string;

  @IsString()
  @IsNotEmpty()
  event: string;

  @IsOptional()
  @IsString()
  product?: string;

  @IsString()
  @IsNotEmpty()
  page_url: string;
}
