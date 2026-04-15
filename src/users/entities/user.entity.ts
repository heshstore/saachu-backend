import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ nullable: true })
  mobile: string;

  @Column({ unique: true, nullable: true })
  email: string;

  @Column({ nullable: true, select: false })
  password_hash: string;

  @Column({ default: 2 })
  commission_rate: number;

  @Column({ default: true })
  is_active: boolean;

  @Column({ type: 'varchar', length: 50, nullable: true })
  role: string;

  @Column({ default: false })
  can_approve_order: boolean;

  @Column({ nullable: true })
  marketing_area: string;
}