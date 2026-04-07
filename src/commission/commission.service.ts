import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Commission } from './entities/commission.entity';

@Injectable()
export class CommissionService {
  constructor(
    @InjectRepository(Commission)
    private commissionRepository: Repository<Commission>,
  ) {}

  // ✅ MONTHLY SUMMARY
  async getMonthlySummary(month: string) {
    const data = await this.commissionRepository.find({
      where: { month },
    });

    const total = data.reduce((sum, c) => sum + c.commission_amount, 0);
    const paid = data
      .filter((c) => c.is_paid)
      .reduce((sum, c) => sum + c.commission_amount, 0);
    const unpaid = total - paid;

    return {
      month,
      total_commission: total,
      paid_commission: paid,
      unpaid_commission: unpaid,
      total_entries: data.length,
    };
  }

  // ✅ SALESMAN REPORT
  async getSalesmanReport(month: string) {
    const data = await this.commissionRepository.find({
      where: { month },
    });

    const report: any = {};

    data.forEach((c) => {
      if (!report[c.salesman_id]) {
        report[c.salesman_id] = {
          salesman_id: c.salesman_id,
          total: 0,
          paid: 0,
          unpaid: 0,
        };
      }

      report[c.salesman_id].total += c.commission_amount;

      if (c.is_paid) {
        report[c.salesman_id].paid += c.commission_amount;
      } else {
        report[c.salesman_id].unpaid += c.commission_amount;
      }
    });

    return Object.values(report);
  }
}