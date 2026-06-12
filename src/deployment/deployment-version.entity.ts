import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index,
} from 'typeorm';

@Entity('deployment_versions')
export class DeploymentVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  @Index()
  version: string;

  @Column({ type: 'timestamptz' })
  deployed_at: Date;

  @Column({ nullable: true })
  backend_commit: string | null;

  @Column({ nullable: true })
  frontend_commit: string | null;

  @Column({ nullable: true })
  bundle_hash: string | null;

  @Column({ nullable: true })
  backup_snapshot: string | null;

  /** Git tag or version string used to restore code. */
  @Column({ nullable: true })
  rollback_code: string | null;

  @Column({ type: 'text', array: true, default: '{}' })
  migration_ids: string[];

  /** PENDING | RELEASED | FAILED | ROLLBACK */
  @Column({ default: 'RELEASED' })
  deployment_status: string;

  @Column({ nullable: true })
  created_by: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  /**
   * SHA-256 of (version|backend_commit|frontend_commit|bundle_hash|
   * backup_snapshot|rollback_code|migration_ids_sorted|deployment_status).
   * Computed at registration time. Mismatch on reload → tamper warning.
   */
  @Column({ nullable: true })
  integrity_hash: string | null;

  /** true when git tag + backup artifacts were both verified at deploy time. */
  @Column({ type: 'boolean', default: false })
  rollback_available: boolean;

  /** manifest.json content from the backup snapshot, stored for audit. */
  @Column({ type: 'jsonb', nullable: true })
  backup_manifest: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
