import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LeadAuditLog, AuditAction } from './entities/lead-audit-log.entity';

@Injectable()
export class LeadAuditService {
  constructor(
    @InjectRepository(LeadAuditLog)
    private auditRepo: Repository<LeadAuditLog>,
  ) {}

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
    await this.auditRepo.save(
      this.auditRepo.create({
        lead_id: leadId,
        user_id: userId,
        action,
        detail: detail ?? null,
        ip_address: ip ?? null,
      }),
    );
  }
}
