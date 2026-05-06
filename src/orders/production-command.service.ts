import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { ProductionJob, ProductionJobStatus } from './entities/production-job.entity';
import { ProductionAlert } from './entities/production-alert.entity';
import { ProductionService } from './production.service';
import { AuditService } from '../logs/audit.service';
import { User } from '../users/entities/user.entity';

interface CommandEvent {
  phone: string;
  body:  string; // already uppercased
}

@Injectable()
export class ProductionCommandService {
  private readonly logger = new Logger(ProductionCommandService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(ProductionJob)
    private readonly jobRepo: Repository<ProductionJob>,
    @InjectRepository(ProductionAlert)
    private readonly alertRepo: Repository<ProductionAlert>,
    private readonly productionService: ProductionService,
    private readonly audit: AuditService,
  ) {}

  @OnEvent('whatsapp.command')
  async handleCommand(event: CommandEvent): Promise<void> {
    try {
      await this.processCommand(event);
    } catch (err: any) {
      this.logger.warn(`Command failed phone=${event.phone}: ${err?.message}`);
    }
  }

  private async processCommand({ phone, body }: CommandEvent): Promise<void> {
    const user = await this.resolveUser(phone);
    if (!user) {
      this.logger.warn(`Unknown user phone=${phone}`);
      return;
    }

    const parts   = body.split(' ');
    const command = parts[0];
    const jobId   = Number(parts[1]);
    if (!jobId || isNaN(jobId)) return;

    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) {
      this.logger.warn(`Job not found id=${jobId}`);
      return;
    }

    switch (command) {
      case 'DONE':  return this.markDone(user, job);
      case 'ISSUE': return this.markIssue(user, job);
      case 'HOLD':  return this.markHold(user, job);
    }
  }

  private async resolveUser(phone: string): Promise<User | null> {
    // Normalise: strip leading country code / spaces, keep last 10 digits
    const digits = phone.replace(/\D/g, '').slice(-10);
    if (digits.length !== 10) return null;

    const rows: User[] = await this.userRepo.manager.query(
      `SELECT * FROM "user" WHERE regexp_replace(mobile, '\\D', '', 'g') LIKE $1`,
      [`%${digits}`],
    );
    return rows[0] ?? null;
  }

  private async markDone(user: User, job: ProductionJob): Promise<void> {
    if (job.assigned_to !== user.id) {
      this.logger.warn(`DONE rejected: job ${job.id} not assigned to user ${user.id}`);
      return;
    }
    await this.productionService.moveToNextStage(job.id);
    this.audit.log({
      entity:    'production_job',
      entity_id: job.id,
      action:    'WHATSAPP_DONE',
      user_id:   user.id,
      meta:      { from: job.current_stage },
    });
  }

  private async markIssue(user: User, job: ProductionJob): Promise<void> {
    await this.alertRepo.save({
      job_id:      job.id,
      alert_type:  'ISSUE',
      notified_to: 1,             // escalate to admin — replace with role lookup if needed
    });
    this.audit.log({
      entity:    'production_job',
      entity_id: job.id,
      action:    'WHATSAPP_ISSUE',
      user_id:   user.id,
      meta:      { stage: job.current_stage, reported_by: user.id },
    });
  }

  private async markHold(user: User, job: ProductionJob): Promise<void> {
    job.status = ProductionJobStatus.PENDING;
    await this.jobRepo.save(job);
    this.audit.log({
      entity:    'production_job',
      entity_id: job.id,
      action:    'WHATSAPP_HOLD',
      user_id:   user.id,
      meta:      { stage: job.current_stage },
    });
  }
}
