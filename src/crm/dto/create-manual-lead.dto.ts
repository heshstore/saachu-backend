import {
  IsEnum, IsNotEmpty, IsOptional, IsString,
  IsNumber, IsDateString, Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { LeadSource, LeadPriority } from '../entities/lead.entity';
import { LEGACY_SOURCE_MAP } from './create-lead.dto';

/**
 * Strict DTO for human-entered leads via POST /crm/leads.
 * Enforces all required fields per CRM spec. Use CreateLeadDto for
 * internal service calls and webhook integrations where fields may be absent.
 */
export class CreateManualLeadDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  @Matches(/^(\+\d{10,15}|\d{10})$/, {
    message: 'Phone must be a 10-digit number or E.164 format (e.g. +919876543210)',
  })
  phone: string;

  @IsNotEmpty()
  @IsString()
  city: string;

  @IsNotEmpty()
  @IsString()
  country: string;

  @IsNotEmpty()
  @IsString()
  product_interest: string;

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
