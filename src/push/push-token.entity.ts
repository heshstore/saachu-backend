import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('user_push_tokens')
@Index('idx_push_token_user', ['user_id'])
@Index('idx_push_token_unique', ['user_id', 'token'], { unique: true })
export class PushToken {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  user_id: number;

  @Column({ type: 'text' })
  token: string;

  @Column({ type: 'varchar', length: 20, default: 'web' })
  platform: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'last_seen_at' })
  last_seen_at: Date;
}
