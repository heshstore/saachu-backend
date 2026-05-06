import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LeadAuditLog, AuditAction } from './entities/lead-audit-log.entity';

@Injectable()
export class LeadAuditService implements OnModuleInit {
  constructor(
    @InjectRepository(LeadAuditLog)
    private auditRepo: Repository<LeadAuditLog>,
  ) {}

  async onModuleInit() {
    try {
      await this.auditRepo.query(`
        CREATE TABLE IF NOT EXISTS lead_audit_logs (
          id          SERIAL PRIMARY KEY,
          lead_id     INT NOT NULL,
          user_id     INT NOT NULL,
          action      VARCHAR(50) NOT NULL,
          detail      TEXT,
          ip_address  VARCHAR(50),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    } catch (e) {
      console.error('Audit log table init failed', e);
    }
  }

  /**
   * Fire-and-forget audit log entry. Always call with `void` to keep the hot path non-blocking.
   * ip_address is optional — only available when the call originates from an HTTP request context.
   */
  async log(
    leadId: number,
    userId: number,
    action: AuditAction,
    detail?: string,
    ip?: string,
  ): Promise<void> {
    try {
      await this.auditRepo.save(
        this.auditRepo.create({
          lead_id: leadId,
          user_id: userId,
          action,
          detail: detail ?? null,
          ip_address: ip ?? null,
        }),
      );
    } catch (e) {
      console.error('Audit log failed', e);
    }
  }
}
