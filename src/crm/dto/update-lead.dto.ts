import { IsEnum, IsOptional, IsString, IsDateString, IsNumber } from 'class-validator';
import { LeadStatus, LeadPriority } from '../entities/lead.entity';

export class UpdateLeadDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  email?: string;

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
  @IsEnum(LeadPriority)
  lead_priority?: LeadPriority;

  @IsOptional()
  @IsNumber()
  quotation_id?: number;

  @IsOptional()
  @IsNumber()
  customer_id?: number;
}
