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

  findOne(id: number) {
    return this.customerRepo.findOne({ where: { id } });
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
}
