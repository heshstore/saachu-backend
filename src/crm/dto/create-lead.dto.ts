import {
  IsBoolean, IsEnum, IsOptional, IsString,
  IsDateString, IsNumber, Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { LeadSource, LeadStatus, LeadPriority } from '../entities/lead.entity';

/** Maps legacy/frontend source strings to canonical LeadSource enum values. */
export const LEGACY_SOURCE_MAP: Record<string, string> = {
  MANUAL:      'DIRECT',
  DIRECT_CALL: 'DIRECT',
  META_ADS:    'META',
  GOOGLE_ADS:  'GOOGLE',
};

/**
 * Flexible DTO used by webhook controllers and internal service calls.
 * All fields are optional — validation is relaxed so Shopify/WhatsApp
 * leads with missing name or phone are still accepted.
 *
 * For human-entered leads from the frontend, use CreateManualLeadDto.
 */
export class CreateLeadDto {
  @IsOptional()
  @IsString()
  name?: string;

  /** Phone optional for anonymous Shopify leads. When provided, must be 10 digits or E.164. */
  @IsOptional()
  @IsString()
  @Matches(/^(\+\d{10,15}|\d{10})$/, {
    message: 'Phone must be a 10-digit number or E.164 format (e.g. +919876543210)',
  })
  phone?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  country?: string;

  /** Accepts legacy values (MANUAL, META_ADS, etc.) and normalises them to canonical enum. */
  @Transform(({ value }) => LEGACY_SOURCE_MAP[value] ?? value)
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

  /** Human-readable context string, e.g. "META – Lead Form". */
  @IsOptional()
  @IsString()
  context?: string;

  @IsOptional()
  @IsString()
  requirement_note?: string;

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
  @IsString()
  lead_source_label?: string;

  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @IsString()
  landing_page?: string;

  @IsOptional()
  raw_payload?: Record<string, any>;

  @IsOptional()
  @IsBoolean()
  is_phone_valid?: boolean;

  @IsOptional()
  @IsString()
  whatsapp_chat_id?: string;

  @IsOptional()
  @IsString()
  whatsappMessageId?: string;

  @IsOptional()
  @IsBoolean()
  hasSerializedId?: boolean;
}
