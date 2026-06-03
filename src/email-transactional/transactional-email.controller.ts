import { Controller, Get, Query } from '@nestjs/common';
import { TransactionalEmailService } from './transactional-email.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('email-transactional')
export class TransactionalEmailController {
  constructor(private readonly emailService: TransactionalEmailService) {}

  /** Live SMTP connectivity check — emits [SMTP_VERIFY_*] logs and returns ok/error. */
  @Get('smtp-verify')
  @RequirePermission('order.view')
  smtpVerify() {
    return this.emailService.verifySmtp();
  }

  /** Read-only log viewer — query by entity_type and/or entity_id. */
  @Get('logs')
  @RequirePermission('order.view')
  getLogs(
    @Query('entity_type') entityType?: string,
    @Query('entity_id')   entityId?: string,
  ) {
    return this.emailService.getLogs(
      entityType,
      entityId ? Number(entityId) : undefined,
    );
  }
}
