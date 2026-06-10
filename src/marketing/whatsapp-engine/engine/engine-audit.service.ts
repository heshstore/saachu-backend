import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export enum AuditEvent {
  AUDIENCE_SELECTED = 'AUDIENCE_SELECTED',
  TEMPLATE_SELECTED = 'TEMPLATE_SELECTED',
  RISK_BLOCKED = 'RISK_BLOCKED',
  NUMBER_COOLDOWN = 'NUMBER_COOLDOWN',
  QUEUE_CREATED = 'QUEUE_CREATED',
  SEND_SKIPPED = 'SEND_SKIPPED',
  LEAD_CREATED = 'LEAD_CREATED',
  DRY_RUN_SEND = 'DRY_RUN_SEND',
  HARD_LIMIT_HIT = 'HARD_LIMIT_HIT',
  HOURLY_CAP_HIT = 'HOURLY_CAP_HIT',
  FINGERPRINT_SKIP = 'FINGERPRINT_SKIP',
  // Phase 9
  LOW_DELIVERY_WARNING = 'LOW_DELIVERY_WARNING',
  LOW_READ_WARNING = 'LOW_READ_WARNING',
  LOW_REPLY_WARNING = 'LOW_REPLY_WARNING',
  WARMUP_RESET = 'WARMUP_RESET',
  WARMUP_PROMOTED = 'WARMUP_PROMOTED',
  NUMBER_RECOVERED = 'NUMBER_RECOVERED',
  // Phase 10
  SCALE_UP = 'SCALE_UP',
  MANUAL_REENABLE = 'MANUAL_REENABLE',
}

export interface AuditParams {
  event: AuditEvent;
  number_id?: string;
  customer_phone?: string;
  template_id?: string;
  campaign_id?: string;
  reason?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class EngineAuditService {
  private readonly logger = new Logger(EngineAuditService.name);

  constructor(
    @InjectDataSource()
    private readonly ds: DataSource,
  ) {}

  async log(params: AuditParams): Promise<void> {
    try {
      await this.ds.query(
        `INSERT INTO engine_audit_logs
           (event, number_id, customer_phone, template_id, campaign_id, reason, score, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          params.event,
          params.number_id ?? null,
          params.customer_phone ?? null,
          params.template_id ?? null,
          params.campaign_id ?? null,
          params.reason ?? null,
          params.score ?? null,
          JSON.stringify(params.metadata ?? {}),
        ],
      );
    } catch (err: any) {
      this.logger.warn(`[AuditLog] Failed to write audit event ${params.event}: ${err?.message}`);
    }
  }
}
