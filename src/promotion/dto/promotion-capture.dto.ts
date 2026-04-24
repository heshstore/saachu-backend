import { IsOptional, IsString, IsEmail, ValidateIf } from 'class-validator';

export class PromotionCaptureDto {
  @IsOptional()
  @IsString()
  whatsapp_number?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  source: string;

  @IsString()
  page_url: string;
}
