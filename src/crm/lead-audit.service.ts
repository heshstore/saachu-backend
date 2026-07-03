import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LeadAuditLog, AuditAction } from './entities/lead-audit-log.entity';

/**
 * Fallback sentinel user_id for automation/cron actions when no real system actor
 * can be resolved from the DB at startup. Value 0 is never a real SERIAL user.
 * Prefer getSystemUserId() over this constant — it returns the runtime-resolved actor.
 */
export const SYSTEM_USER_ID = 0;

@Injectable()
export class LeadAuditService implements OnModuleInit {
  private readonly logger = new Logger(LeadAuditService.name);

  // Resolved in onModuleInit() to the first active Admin/COO user. Falls back to 0.
  private systemUserId = 0;

  constructor(
    @InjectRepository(LeadAuditLog)
    private auditRepo: Repository<LeadAuditLog>,
  ) {}

  /** Returns the runtime-resolved system actor user_id (or 0 if resolution failed). */
  getSystemUserId(): number {
    return this.systemUserId;
  }

  async onModuleInit() {
    // lead_audit_logs table creation moved to scripts/migrate-crm-phase20-1-startup-cleanup.js
    try {
      const [row] = await this.auditRepo.query(
        `SELECT id FROM "user" WHERE role IN ('Admin', 'COO') AND is_active = true ORDER BY id ASC LIMIT 1`,
      );
      if (row?.id) {
        this.systemUserId = Number(row.id);
        this.logger.log(
          `[SYS_AUDIT] System actor resolved: user_id=${this.systemUserId}`,
        );
      } else {
        this.logger.warn(
          '[SYS_AUDIT] No active Admin/COO found — automation audits will use user_id=0',
        );
      }
    } catch (e) {
      this.logger.warn(
        `[SYS_AUDIT] System actor resolution failed — falling back to user_id=0: ${e?.message}`,
      );
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
    const effectiveUserId =
      userId != null && Number.isFinite(userId) ? userId : SYSTEM_USER_ID;
    if (effectiveUserId === SYSTEM_USER_ID) {
      this.logger.debug(
        `[SYS_AUDIT] lead=${leadId} action=${action} — using SYSTEM user`,
      );
    }
    try {
      await this.auditRepo.save(
        this.auditRepo.create({
          lead_id: leadId,
          user_id: effectiveUserId,
          action,
          detail: detail ?? null,
          ip_address: ip ?? null,
        }),
      );
    } catch (e) {
      // Never let audit failures crash the caller — always fire-and-forget
      console.error('Audit log failed', e);
    }
  }
}
