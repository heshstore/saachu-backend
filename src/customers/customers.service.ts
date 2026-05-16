import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Customer } from './entities/customer.entity';
import { CustomerPhone } from './entities/customer-phone.entity';
import { normalizePhone } from '../crm/normalizers/lead-normalizer';

@Injectable()
export class CustomersService {
  constructor(
    @InjectRepository(Customer)
    private customerRepo: Repository<Customer>,
    @InjectRepository(CustomerPhone)
    private customerPhoneRepo: Repository<CustomerPhone>,
  ) {}

  /** Returns the customer whose phone number (mobile1 or mobile2) matches. */
  async findByPhone(phone: string): Promise<Customer | null> {
    const row = await this.customerPhoneRepo.findOne({ where: { phone } });
    if (!row) return null;
    return this.customerRepo.findOne({ where: { id: row.customer_id } });
  }

  /**
   * Registers new phones into customer_phones (used at creation time).
   * Skips phones already owned by this customer.
   * Throws if a phone belongs to a different customer.
   */
  private async registerPhones(customerId: number, phones: (string | undefined | null)[]): Promise<void> {
    for (const phone of phones) {
      if (!phone || phone === 'unknown') continue;
      const existing = await this.customerPhoneRepo.findOne({ where: { phone } });
      if (existing && existing.customer_id !== customerId) {
        throw new BadRequestException(
          `Phone ${phone} is already registered to another customer (id=${existing.customer_id})`,
        );
      }
      if (!existing) {
        await this.customerPhoneRepo.save({ customer_id: customerId, phone });
      }
    }
  }

  /**
   * Safely transitions a phone entry in customer_phones when a phone number changes.
   * All three steps run inside a single transaction — any failure rolls back the whole set.
   *
   * Steps:
   *   1. Delete old phone row (no orphan mappings).
   *   2. Insert new phone row (guard against cross-customer conflict).
   *   3. Link all leads with the new phone to this customer.
   */
  private async syncPhone(
    customerId: number,
    oldPhone: string | null | undefined,
    newPhone: string | null | undefined,
  ): Promise<void> {
    if (newPhone === undefined) return; // field not in update payload
    if (oldPhone === newPhone) return;  // no change

    // Conflict check before opening the transaction to produce a clear error message.
    if (newPhone) {
      const conflict = await this.customerPhoneRepo.findOne({ where: { phone: newPhone } });
      if (conflict && conflict.customer_id !== customerId) {
        throw new BadRequestException(
          `Phone ${newPhone} is already registered to another customer (id=${conflict.customer_id})`,
        );
      }
    }

    await this.customerRepo.manager.transaction(async (txm) => {
      // 1. Remove old mapping — no orphan entries after this point
      if (oldPhone) {
        await txm.query(
          `DELETE FROM customer_phones WHERE customer_id = $1 AND phone = $2`,
          [customerId, oldPhone],
        );
      }

      if (!newPhone) return; // phone cleared — nothing more to do

      // 2. Insert new mapping (ON CONFLICT DO NOTHING for idempotency inside retries)
      await txm.query(
        `INSERT INTO customer_phones (customer_id, phone)
         VALUES ($1, $2)
         ON CONFLICT (phone) DO NOTHING`,
        [customerId, newPhone],
      );

      // 3. Back-link any leads that share this phone number
      await txm.query(
        `UPDATE leads
         SET customer_id = $1
         WHERE phone = $2
           AND (customer_id IS NULL OR customer_id != $1)`,
        [customerId, newPhone],
      );
    });
  }

  async create(data: any): Promise<Customer> {
    const tag = data.tag?.trim().toLowerCase();

    // Normalize phones to E.164 before any dedup or save
    const mobile1Raw = (data.mobile1 || '').trim();
    const mobile1 = mobile1Raw ? normalizePhone(mobile1Raw) : undefined;
    if (mobile1Raw && (!mobile1 || mobile1 === 'unknown')) {
      throw new BadRequestException('Invalid mobile number — must be a valid 10-digit Indian number');
    }

    const mobile2Raw = (data.mobile2 || '').trim();
    const mobile2 = mobile2Raw ? normalizePhone(mobile2Raw) : undefined;
    if (mobile2Raw && (!mobile2 || mobile2 === 'unknown')) {
      throw new BadRequestException('Invalid secondary mobile number');
    }

    const gstNumber = data.gstNumber?.trim() || null;

    data.tag = tag;
    data.mobile1 = mobile1;
    data.mobile2 = mobile2 ?? null;
    data.gstNumber = gstNumber;

    // Global phone dedup — one phone can belong to exactly one customer
    if (mobile1) {
      const existingByPhone = await this.findByPhone(mobile1);
      if (existingByPhone) return existingByPhone;
    }
    if (mobile2) {
      const existingByPhone = await this.findByPhone(mobile2);
      if (existingByPhone) return existingByPhone;
    }

    // Composite (companyName + tag + city) dedup
    const existingCombo = await this.customerRepo.findOne({
      where: { companyName: data.companyName, tag, city: data.city },
    });
    if (existingCombo) {
      throw new BadRequestException(
        `A customer "${data.companyName}" with tag "${tag}" in "${data.city}" already exists`,
      );
    }

    // GST dedup (only when provided)
    if (gstNumber) {
      const existingGst = await this.customerRepo.findOne({ where: { gstNumber } });
      if (existingGst) throw new BadRequestException('GST already exists');
    }

    let saved: Customer;
    try {
      saved = await this.customerRepo.save(data);
    } catch (error) {
      if (error.code === '23505') throw new BadRequestException('Duplicate entry not allowed');
      throw error;
    }

    await this.registerPhones(saved.id, [mobile1, mobile2]);

    return saved;
  }

  findAll() {
    return this.customerRepo.find();
  }

  async findOne(id: number) {
    const customer = await this.customerRepo.findOne({ where: { id } });
    if (!customer) return null;

    const em = this.customerRepo.manager;

    const [
      [origSalesman],
      [latestOrder],
      [latestTicket],
      leadRows,
    ] = await Promise.all([
      em.query(
        `SELECT l.assigned_to, u.name AS salesman_name, u.mobile AS salesman_phone, u.role AS salesman_role
         FROM leads l
         LEFT JOIN "user" u ON u.id = l.assigned_to
         WHERE l.customer_id = $1
         ORDER BY l.updated_at DESC NULLS LAST, l.id DESC
         LIMIT 1`,
        [id],
      ),
      em.query(
        `SELECT o.id, o.order_no, o.salesman_id, sm.name AS order_salesman_name
         FROM orders o
         LEFT JOIN "user" sm ON sm.id = o.salesman_id
         WHERE o.customer_id = $1
         ORDER BY o.id DESC LIMIT 1`,
        [id],
      ),
      em.query(
        `SELECT t.id, t.ticket_number, t.assigned_to, tech.name AS service_owner_name
         FROM service_tickets t
         LEFT JOIN "user" tech ON tech.id = t.assigned_to
         WHERE t.customer_id = $1
         ORDER BY t.id DESC LIMIT 1`,
        [id],
      ),
      em.query(
        `SELECT id, lead_ref, status, stage, source, created_at
         FROM leads
         WHERE customer_id = $1 AND is_active = true
         ORDER BY created_at DESC LIMIT 20`,
        [id],
      ),
    ]);

    const totalLeads = leadRows.length;
    const convertedLeads = leadRows.filter((l: any) => l.status === 'CONVERTED').length;
    const lostLeads = leadRows.filter((l: any) => l.status === 'LOST').length;
    const conversionRate = totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) : 0;

    return {
      ...customer,
      lifecycle: {
        original_salesman_name: origSalesman?.salesman_name ?? null,
        original_salesman_phone: origSalesman?.salesman_phone ?? null,
        original_salesman_role: origSalesman?.salesman_role ?? null,
        latest_order_no: latestOrder?.order_no ?? null,
        latest_order_salesman_name: latestOrder?.order_salesman_name ?? null,
        latest_service_ticket: latestTicket?.ticket_number ?? null,
        latest_service_owner_name: latestTicket?.service_owner_name ?? null,
      },
      leadHistory: leadRows,
      leadStats: { totalLeads, convertedLeads, lostLeads, conversionRate },
    };
  }

  async update(id: number, data: any): Promise<Customer> {
    // Fetch current record so we know which phones are changing
    const current = await this.customerRepo.findOne({ where: { id } });
    if (!current) throw new NotFoundException('Customer not found');

    // Normalize any phones being updated
    if (data.mobile1 !== undefined) {
      const raw = (data.mobile1 || '').trim();
      data.mobile1 = raw ? normalizePhone(raw) : null;
      if (raw && (!data.mobile1 || data.mobile1 === 'unknown')) {
        throw new BadRequestException('Invalid mobile number');
      }
    }
    if (data.mobile2 !== undefined) {
      const raw = (data.mobile2 || '').trim();
      data.mobile2 = raw ? normalizePhone(raw) : null;
      if (raw && (!data.mobile2 || data.mobile2 === 'unknown')) {
        throw new BadRequestException('Invalid secondary mobile number');
      }
    }

    // Persist customer changes
    await this.customerRepo.update(id, data);

    // Sync phone index: remove old mappings, insert new ones, link leads
    await this.syncPhone(id, current.mobile1, data.mobile1);
    await this.syncPhone(id, current.mobile2, data.mobile2);

    return this.findOne(id);
  }

  remove(id: number) {
    return this.customerRepo.delete(id);
  }

  async getTimeline(id: number, limit = 50): Promise<any[]> {
    const em = this.customerRepo.manager;
    const [leadsRows, quotationsRows, ordersRows, ticketsRows, receivablesRows] = await Promise.all([
      em.query(
        `SELECT id, 'lead' AS type, status, stage AS sub_status, source,
                created_at AS event_date, NULL AS amount, NULL AS ref_no
         FROM leads WHERE customer_id = $1 AND is_active = true
         ORDER BY created_at DESC LIMIT 20`,
        [id],
      ),
      em.query(
        `SELECT id, 'quotation' AS type, status, NULL AS sub_status, NULL AS source,
                created_at AS event_date, total_amount AS amount, quotation_no AS ref_no
         FROM quotation WHERE customer_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [id],
      ),
      em.query(
        `SELECT id, 'order' AS type, status, NULL AS sub_status, NULL AS source,
                created_at AS event_date, total_amount AS amount, order_no AS ref_no
         FROM orders WHERE customer_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [id],
      ),
      em.query(
        `SELECT id, 'service_ticket' AS type, status, NULL AS sub_status, NULL AS source,
                created_at AS event_date, NULL AS amount, ticket_number AS ref_no
         FROM service_tickets WHERE customer_id = $1
         ORDER BY created_at DESC LIMIT 10`,
        [id],
      ),
      em.query(
        `SELECT id, 'payment' AS type, status, NULL AS sub_status, NULL AS source,
                created_at AS event_date, outstanding_amount AS amount, NULL AS ref_no
         FROM customer_receivables WHERE customer_id = $1
         ORDER BY created_at DESC LIMIT 10`,
        [id],
      ),
    ]);

    const all = [...leadsRows, ...quotationsRows, ...ordersRows, ...ticketsRows, ...receivablesRows];
    all.sort((a, b) => new Date(b.event_date).getTime() - new Date(a.event_date).getTime());
    return all.slice(0, limit);
  }
}
