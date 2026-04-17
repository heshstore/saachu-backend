import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { Notification } from './notification.entity';

@Injectable()
export class NotificationService {
  private waService: any = null;

  constructor(
    @InjectRepository(Notification)
    private notifRepo: Repository<Notification>,
    @InjectDataSource()
    private ds: DataSource,
  ) {}

  // WhatsAppService injected lazily to avoid circular dep
  setWhatsAppService(wa: any) {
    this.waService = wa;
  }

  async create(
    userId: number,
    title: string,
    body: string,
    type = 'lead_followup',
    refId?: number,
  ): Promise<Notification> {
    const notif = this.notifRepo.create({ user_id: userId, title, body, type, ref_id: refId });
    return this.notifRepo.save(notif);
  }

  async getForUser(userId: number): Promise<Notification[]> {
    return this.notifRepo.find({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
      take: 50,
    });
  }

  async markRead(id: number, userId: number): Promise<void> {
    await this.notifRepo.update({ id, user_id: userId }, { is_read: true });
  }

  async markAllRead(userId: number): Promise<void> {
    await this.notifRepo.update({ user_id: userId }, { is_read: true });
  }

  @Cron('*/15 * * * *')
  async handleFollowUpReminders(): Promise<void> {
    const window = new Date(Date.now() + 30 * 60 * 1000);

    const dues = await this.ds.query(`
      SELECT f.id AS fu_id, f.note, f.lead_id,
             l.name AS lead_name, l.phone AS lead_phone, l.assigned_to
      FROM lead_followups f
      JOIN leads l ON l.id = f.lead_id
      WHERE f.is_completed = false
        AND f.due_date <= $1
        AND l.is_active = true
        AND l.assigned_to IS NOT NULL
    `, [window]);

    for (const row of dues) {
      if (!row.assigned_to) continue;

      // Dedup: skip if notification already exists for this follow-up
      const existing = await this.notifRepo.findOne({
        where: { type: 'lead_followup', ref_id: row.fu_id, user_id: row.assigned_to },
      });
      if (existing) continue;

      const title = `Follow-up: ${row.lead_name}`;
      const body = row.note || `Call ${row.lead_name} (${row.lead_phone})`;

      await this.create(row.assigned_to, title, body, 'lead_followup', row.fu_id);

      // WhatsApp reminder to assignee if connected
      if (this.waService?.isConnected?.()) {
        this.waService
          .sendToAssignee(row.assigned_to, `Reminder: ${title}\n${body}`)
          .catch(() => { /* silent */ });
      }
    }
  }
}
