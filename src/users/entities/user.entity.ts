import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column()
  mobile: string;

  @Column({ default: 2 })
  commission_rate: number;

  @Column({ default: true })
  is_active: boolean;

  @Column({ type: 'varchar', length: 50, nullable: true })
  role: string;

  @Column({ default: false })
  can_approve_order: boolean;
}