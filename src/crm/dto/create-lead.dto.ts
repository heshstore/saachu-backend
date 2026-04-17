import { IsEnum, IsNotEmpty, IsOptional, IsString, IsDateString, IsNumber } from 'class-validator';
import { LeadSource, LeadStatus, LeadPriority } from '../entities/lead.entity';

export class CreateLeadDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  phone: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsEnum(LeadSource)
  source: LeadSource;

  @IsOptional()
  @IsEnum(LeadStatus)
  status?: LeadStatus;

  @IsOptional()
  @IsNumber()
  assigned_to?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  follow_up_date?: string;

  @IsOptional()
  @IsString()
  product_interest?: string;

  @IsOptional()
  @IsString()
  utm_source?: string;

  @IsOptional()
  @IsString()
  utm_campaign?: string;

  @IsOptional()
  @IsEnum(LeadPriority)
  lead_priority?: LeadPriority;

  @IsOptional()
  @IsString()
  external_id?: string;

  @IsOptional()
  raw_payload?: Record<string, any>;
}
