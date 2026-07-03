import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('logs')
export class Log {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text' })
  action: string;

  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, any>;

  @Column({ type: 'int', nullable: true })
  user_id: number;

  @Column({ type: 'text', nullable: true })
  ip: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
