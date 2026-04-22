import { IsEnum, IsOptional, IsString, IsDateString } from 'class-validator';
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
  @IsString()
  city?: string;

  @IsOptional()
  @IsEnum(LeadStatus)
  status?: LeadStatus;

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

  // assigned_to  → use PATCH /:id/assign       (requires lead.assign)
  // customer_id  → use PATCH /:id/mark-converted (requires lead.convert)
  // quotation_id → use PATCH /:id/mark-converted (requires lead.convert)
}
