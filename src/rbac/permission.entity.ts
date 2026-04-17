import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('permission')
export class Permission {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  key: string;

  @Column()
  label: string;

  @Column()
  module: string;
}
