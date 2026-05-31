import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('promotion_product_rotation')
@Index('idx_ppr_telecaller_sku', ['telecaller_number_id', 'sku'])
@Index('idx_ppr_telecaller_sent_at', ['telecaller_number_id', 'sent_at'])
export class PromotionProductRotation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  telecaller_number_id: string;

  @Column({ type: 'int' })
  product_id: number;

  /** Denormalized for historical stability — survives catalog renames */
  @Column({ type: 'varchar' })
  sku: string;

  @Column({ type: 'uuid', nullable: true })
  campaign_id: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'sent_at' })
  sent_at: Date;
}
