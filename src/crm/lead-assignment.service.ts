import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CrmSettings } from './entities/crm-settings.entity';
import { User } from '../users/entities/user.entity';
import { LeadSource } from './entities/lead.entity';

// ── Role configuration ────────────────────────────────────────────────────────
// These are the exact role strings stored in the users.role column.
// If a user exists but leads are never assigned to them, check that their role
// exactly matches one of these strings (case-sensitive).
const ELIGIBLE_ROLES = [
  'Tele calling Executive',   // primary telecalling pool
  'Territory Manager',        // handles regional leads
  'Field Executive',          // on-ground field assignments
];

// crm_settings key for the global round-robin pointer.
// A single pointer gives even distribution regardless of which source a lead came
// from. Future territory routing uses separate keys per region (see selectCandidates).
const GLOBAL_RR_KEY = 'round_robin_global';

// ── Extensibility interfaces ──────────────────────────────────────────────────

/** Subset of User fields needed for assignment decisions. */
export interface AssignmentCandidate {
  id: number;
  name: string;
  marketing_area: string | null;
}

/**
 * Context passed to selectCandidates(). Extend this as new routing dimensions
 * are added (territory, priority, channel, shift, etc.) without changing the
 * round-robin core.
 */
export interface AssignmentContext {
  source: LeadSource;
  /** ISO 2-letter state code or city name — future territory routing */
  region?: string;
  /** Lead priority — future priority-weighted assignment */
  priority?: string;
}

@Injectable()
export class LeadAssignmentService {
  private readonly logger = new Logger(LeadAssignmentService.name);

  constructor(
    @InjectRepository(CrmSettings)
    private settingsRepo: Repository<CrmSettings>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectDataSource()
    private dataSource: DataSource,
  ) {}

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Returns the next eligible user ID for assignment using global round-robin,
   * or null if no eligible telecaller is active.
   *
   * Designed to be called once per lead creation. The round-robin pointer is
   * advanced atomically inside a transaction to survive concurrent requests.
   */
  async getNextAssignee(source: LeadSource, context?: Partial<AssignmentContext>): Promise<number | null> {
    const allEligible = await this.loadEligibleUsers();
    if (!allEligible.length) {
      this.logger.warn(
        `[Assignment] No active users found with roles [${ELIGIBLE_ROLES.join(', ')}] — lead will be unassigned`,
      );
      return null;
    }

    const ctx: AssignmentContext = { source, ...context };
    const candidates = this.selectCandidates(allEligible, ctx);

    if (!candidates.length) {
      this.logger.warn(
        `[Assignment] No candidates after filtering (source=${source}, region=${ctx.region ?? 'any'}) — lead will be unassigned`,
      );
      return null;
    }

    const assignedId = await this.advanceRoundRobin(candidates, ctx);
    const assignedUser = candidates.find((c) => c.id === assignedId);
    this.logger.log(
      `[Assignment] source=${source} → user_id=${assignedId} (${assignedUser?.name ?? '?'})` +
      (ctx.region ? ` region=${ctx.region}` : ''),
    );

    return assignedId;
  }

  // ── Candidate selection ───────────────────────────────────────────────────────

  /**
   * Filters the full eligible pool down to the candidates relevant for this lead.
   *
   * Currently returns all eligible users (global pool).
   *
   * TERRITORY ROUTING (future): when `context.region` is set, filter by
   * `u.marketing_area` matching the region. Fall back to global pool if the
   * regional pool is empty so no lead is ever left unassigned due to a config gap.
   *
   * PRIORITY ROUTING (future): when `context.priority === 'HIGH'`, prefer users
   * whose role is 'Territory Manager' or 'Field Executive' (senior handlers).
   */
  private selectCandidates(
    pool: AssignmentCandidate[],
    context: AssignmentContext,
  ): AssignmentCandidate[] {
    // ── Future: territory routing ──────────────────────────────────────────────
    // if (context.region) {
    //   const regional = pool.filter(
    //     (u) => u.marketing_area?.toLowerCase() === context.region!.toLowerCase(),
    //   );
    //   if (regional.length) return regional;
    //   this.logger.warn(`[Assignment] No users for region=${context.region} — falling back to global pool`);
    // }

    // ── Future: priority routing ───────────────────────────────────────────────
    // if (context.priority === 'HIGH') {
    //   const senior = pool.filter((u) => ['Territory Manager', 'Field Executive'].includes(u.role));
    //   if (senior.length) return senior;
    // }

    return pool;
  }

  // ── Round-robin core ──────────────────────────────────────────────────────────

  /**
   * Advances the round-robin pointer for the given candidate set and returns the
   * next user ID. Uses SELECT FOR UPDATE to prevent two concurrent lead creations
   * from assigning the same user.
   *
   * Stores the last-assigned user ID (not array index) so rotation survives
   * deactivation: if user 5 is deactivated, findIndex returns -1, and the next
   * call picks index 0 — no users are skipped or double-assigned.
   *
   * The settings key incorporates the candidate set size so territory pools don't
   * share a pointer with the global pool. When territory routing is added, pass a
   * stable region identifier as the key suffix.
   */
  private async advanceRoundRobin(
    candidates: AssignmentCandidate[],
    context: AssignmentContext,
  ): Promise<number> {
    // One settings row per distinct assignment pool. Currently only 'global' exists.
    // When territory routing is added: `round_robin_${context.region ?? 'global'}`
    const key = GLOBAL_RR_KEY;

    return this.dataSource.transaction(async (em) => {
      const settingsRepo = em.getRepository(CrmSettings);

      let row = await settingsRepo
        .createQueryBuilder('s')
        .setLock('pessimistic_write')
        .where('s.key = :key', { key })
        .getOne();

      if (!row) {
        row = settingsRepo.create({ key, value: null });
      }

      const lastUserId = row.value ? parseInt(row.value, 10) : null;
      const lastPos = (lastUserId && !isNaN(lastUserId))
        ? candidates.findIndex((c) => c.id === lastUserId)
        : -1;

      const nextIndex = (lastPos + 1) % candidates.length;
      const next = candidates[nextIndex];

      row.value = String(next.id);
      row.updated_at = new Date();
      await settingsRepo.save(row);

      return next.id;
    });
  }

  // ── Data loading ──────────────────────────────────────────────────────────────

  private async loadEligibleUsers(): Promise<AssignmentCandidate[]> {
    return this.userRepo
      .createQueryBuilder('u')
      .where('u.is_active = true')
      .andWhere('u.role IN (:...roles)', { roles: ELIGIBLE_ROLES })
      .orderBy('u.id', 'ASC')
      .select(['u.id', 'u.name', 'u.marketing_area'])
      .getMany() as Promise<AssignmentCandidate[]>;
  }
}
