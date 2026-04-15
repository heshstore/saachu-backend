import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity("cities")
export class City {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column()
  state: string;

  @Column()
  country: string;

  /** ISO 3166-1 alpha-2, e.g. "IN", "US" */
  @Column({ nullable: true })
  countryISO: string;

  /** Calling code, e.g. "+91", "+1" */
  @Column({ nullable: true })
  countryCode: string;
}