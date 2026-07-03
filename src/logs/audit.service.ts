import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';

export interface AuditInput {
  entity: string;
  entity_id: number;
  action: string;
  user_id?: number;
  actor_type?: 'USER' | 'SYSTEM';
  meta?: Record<string, any>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly repo: Repository<AuditLog>,
  ) {}

  log(input: AuditInput): void {
    this.repo
      .save(
        this.repo.create({
          ...input,
          actor_type: input.actor_type ?? 'USER',
        }),
      )
      .catch((err) =>
        this.logger.error(
          `Audit write failed action=${input.action}: ${err?.message}`,
        ),
      );
  }

  async getByEntity(entity: string, entityId: number): Promise<AuditLog[]> {
    return this.repo.find({
      where: { entity, entity_id: entityId },
      order: { created_at: 'DESC' },
    });
  }
}
