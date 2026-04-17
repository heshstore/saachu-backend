import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CrmSettings } from './entities/crm-settings.entity';
import { User } from '../users/entities/user.entity';
import { LeadSource } from './entities/lead.entity';

const ELIGIBLE_ROLES = [
  'Tele calling Executive',
  'Territory Manager',
  'Field Executive',
];

@Injectable()
export class LeadAssignmentService {
  constructor(
    @InjectRepository(CrmSettings)
    private settingsRepo: Repository<CrmSettings>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectDataSource()
    private dataSource: DataSource,
  ) {}

  async getNextAssignee(source: LeadSource): Promise<number | null> {
    const eligibleUsers = await this.userRepo
      .createQueryBuilder('u')
      .where('u.is_active = true')
      .andWhere('u.role IN (:...roles)', { roles: ELIGIBLE_ROLES })
      .orderBy('u.id', 'ASC')
      .select(['u.id'])
      .getMany();

    if (!eligibleUsers.length) return null;

    const key = `round_robin_${source}`;

    return this.dataSource.transaction(async (em) => {
      // Lock the settings row to prevent race conditions
      let row = await em
        .getRepository(CrmSettings)
        .createQueryBuilder('s')
        .setLock('pessimistic_write')
        .where('s.key = :key', { key })
        .getOne();

      let lastIndex = -1;
      if (row) {
        lastIndex = parseInt(row.value || '-1', 10);
      } else {
        row = em.getRepository(CrmSettings).create({ key, value: '-1' });
      }

      const nextIndex = (lastIndex + 1) % eligibleUsers.length;
      row.value = String(nextIndex);
      row.updated_at = new Date();
      await em.getRepository(CrmSettings).save(row);

      return eligibleUsers[nextIndex].id;
    });
  }
}
