import { IsOptional, IsString, IsEmail, ValidateIf } from 'class-validator';

export class PromotionCaptureDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  whatsapp_number?: string;

  @ValidateIf(
    (o) => o.email !== '' && o.email !== undefined && o.email !== null,
  )
  @IsEmail()
  @IsOptional()
  email?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  page_url?: string;

  @IsOptional()
  @IsString()
  tag?: string;
}
