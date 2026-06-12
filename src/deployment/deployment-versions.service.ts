import {
  Injectable, ConflictException, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
import { DeploymentVersion } from './deployment-version.entity';

export interface RegisterDeploymentDto {
  version: string;
  deployed_at: string;
  backend_commit?: string | null;
  frontend_commit?: string | null;
  bundle_hash?: string | null;
  backup_snapshot?: string | null;
  rollback_code?: string | null;
  migration_ids?: string[];
  deployment_status?: string;
  created_by?: string | null;
  notes?: string | null;
  rollback_available?: boolean;
  backup_manifest?: Record<string, any> | null;
}

export interface RollbackReadinessReport {
  version: string;
  ready: boolean;
  rollback_available: boolean;
  checks: {
    record_exists: boolean;
    status_released: boolean;
    backup_snapshot: boolean;
    manifest_present: boolean;
    backend_artifact: boolean;
    frontend_artifact: boolean;
    db_snapshot: boolean;
    integrity_hash: boolean;
    rollback_available_flag: boolean;
  };
}

const VALID_STATUSES = ['PENDING', 'RELEASED', 'FAILED', 'ROLLBACK'];

@Injectable()
export class DeploymentVersionsService {
  constructor(
    @InjectRepository(DeploymentVersion)
    private readonly repo: Repository<DeploymentVersion>,
  ) {}

  async findAll(): Promise<DeploymentVersion[]> {
    return this.repo.find({ order: { deployed_at: 'DESC' } });
  }

  async findOne(version: string): Promise<DeploymentVersion | null> {
    return this.repo.findOne({ where: { version } });
  }

  async register(dto: RegisterDeploymentDto): Promise<DeploymentVersion> {
    const existing = await this.repo.findOne({ where: { version: dto.version } });
    if (existing) {
      throw new ConflictException(`Version ${dto.version} already registered`);
    }

    const status = dto.deployment_status ?? 'RELEASED';
    if (!VALID_STATUSES.includes(status)) {
      throw new BadRequestException(`Invalid deployment_status: ${status}`);
    }

    const integrity_hash = this.computeHash({ ...dto, deployment_status: status });

    const entry = this.repo.create({
      version:            dto.version,
      deployed_at:        new Date(dto.deployed_at),
      backend_commit:     dto.backend_commit  ?? null,
      frontend_commit:    dto.frontend_commit ?? null,
      bundle_hash:        dto.bundle_hash     ?? null,
      backup_snapshot:    dto.backup_snapshot ?? null,
      rollback_code:      dto.rollback_code   ?? dto.version,
      migration_ids:      dto.migration_ids   ?? [],
      deployment_status:  status,
      created_by:         dto.created_by      ?? null,
      notes:              dto.notes           ?? null,
      rollback_available: dto.rollback_available ?? false,
      backup_manifest:    dto.backup_manifest ?? null,
      integrity_hash,
    });
    return this.repo.save(entry);
  }

  async updateStatus(
    version: string,
    status: string,
    rollbackAvailable?: boolean,
  ): Promise<DeploymentVersion> {
    if (!VALID_STATUSES.includes(status)) {
      throw new BadRequestException(`Invalid status: ${status}`);
    }
    const existing = await this.repo.findOne({ where: { version } });
    if (!existing) {
      throw new NotFoundException(`Version ${version} not found`);
    }
    existing.deployment_status = status;
    if (rollbackAvailable !== undefined) {
      existing.rollback_available = rollbackAvailable;
    }
    // Recompute — deployment_status is part of the hash payload
    existing.integrity_hash = this.computeHash({
      version:           existing.version,
      backend_commit:    existing.backend_commit,
      frontend_commit:   existing.frontend_commit,
      bundle_hash:       existing.bundle_hash,
      backup_snapshot:   existing.backup_snapshot,
      rollback_code:     existing.rollback_code,
      migration_ids:     existing.migration_ids,
      deployment_status: existing.deployment_status,
    });
    return this.repo.save(existing);
  }

  async rollbackReadiness(version: string): Promise<RollbackReadinessReport> {
    const record = await this.repo.findOne({ where: { version } });
    const falseChecks = {
      record_exists:           false,
      status_released:         false,
      backup_snapshot:         false,
      manifest_present:        false,
      backend_artifact:        false,
      frontend_artifact:       false,
      db_snapshot:             false,
      integrity_hash:          false,
      rollback_available_flag: false,
    };
    if (!record) {
      return { version, ready: false, rollback_available: false, checks: falseChecks };
    }
    const m = record.backup_manifest as any;
    const checks = {
      record_exists:           true,
      status_released:         record.deployment_status === 'RELEASED',
      backup_snapshot:         !!record.backup_snapshot,
      manifest_present:        !!m,
      backend_artifact:        m ? !!m.backend_dist_exists   : false,
      frontend_artifact:       m ? !!m.frontend_build_exists : false,
      db_snapshot:             m ? !!m.db_snapshot_exists    : false,
      integrity_hash:          !!record.integrity_hash,
      rollback_available_flag: record.rollback_available,
    };
    const ready = Object.values(checks).every(Boolean);
    return { version, ready, rollback_available: record.rollback_available, checks };
  }

  computeHash(dto: Partial<RegisterDeploymentDto>): string {
    const payload = [
      dto.version           ?? '',
      dto.backend_commit    ?? '',
      dto.frontend_commit   ?? '',
      dto.bundle_hash       ?? '',
      dto.backup_snapshot   ?? '',
      dto.rollback_code     ?? '',
      (dto.migration_ids    ?? []).slice().sort().join(','),
      dto.deployment_status ?? '',
    ].join('|');
    return createHash('sha256').update(payload).digest('hex');
  }
}
