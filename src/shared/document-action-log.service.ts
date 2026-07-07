import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export type DocumentActionType = 'view' | 'edit' | 'print' | 'pdf' | 'whatsapp';

const VALID_ACTIONS: DocumentActionType[] = [
  'view',
  'edit',
  'print',
  'pdf',
  'whatsapp',
];

/**
 * Generic click-tracking for document action buttons (View / Edit / Print /
 * PDF / WhatsApp) across Quotation, Order, and Invoice. Email sends have
 * their own richer log (transactional_email_logs) via TransactionalEmailService.
 */
@Injectable()
export class DocumentActionLogService {
  private readonly logger = new Logger(DocumentActionLogService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async record(
    entityType: 'quotation' | 'order' | 'invoice',
    entityId: number,
    action: DocumentActionType,
  ): Promise<void> {
    if (!VALID_ACTIONS.includes(action)) return;
    try {
      await this.dataSource.query(
        `INSERT INTO document_action_log (entity_type, entity_id, action) VALUES ($1, $2, $3)`,
        [entityType, entityId, action],
      );
    } catch (err: any) {
      // Click tracking must never break the actual user-facing action.
      this.logger.warn(
        `[DOC_ACTION_LOG_FAILED] type=${entityType} id=${entityId} action=${action}: ${err?.message}`,
      );
    }
  }
}
