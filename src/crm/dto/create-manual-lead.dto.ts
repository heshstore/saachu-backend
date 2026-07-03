import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsNumber,
  IsDateString,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { LeadSource, LeadPriority } from '../entities/lead.entity';
import { LEGACY_SOURCE_MAP } from './create-lead.dto';

/**
 * DTO for human-entered leads via POST /crm/leads.
 * Phone is optional — walk-in, exhibition, business card, and referral leads
 * often lack a mobile number at time of entry. The quality engine marks these
 * PARTIAL and skips telecaller auto-assignment until a phone is enriched later.
 */
export class CreateManualLeadDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  /** Optional — manual leads (walk-in, referral, business card) may not have a mobile yet. */
  @IsOptional()
  @IsString()
  @Matches(/^(\+\d{10,15}|\d{10})$/, {
    message:
      'Phone must be a 10-digit number or E.164 format (e.g. +919876543210)',
  })
  phone?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  product_interest?: string;

  /** Accepts legacy values (MANUAL, META_ADS, etc.) and normalises them to canonical enum. */
  @Transform(({ value }) => LEGACY_SOURCE_MAP[value] ?? value)
  @IsEnum(LeadSource)
  source: LeadSource;

  /** Context defaults to "DIRECT – Manual Entry" in service if not provided. */
  @IsOptional()
  @IsString()
  context?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  requirement_note?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsEnum(LeadPriority)
  lead_priority?: LeadPriority;

  @IsOptional()
  @IsNumber()
  assigned_to?: number;

  @IsOptional()
  @IsDateString()
  follow_up_date?: string;

  @IsOptional()
  @IsString()
  utm_source?: string;

  @IsOptional()
  @IsString()
  utm_campaign?: string;

  @IsOptional()
  @IsString()
  state?: string;
}
