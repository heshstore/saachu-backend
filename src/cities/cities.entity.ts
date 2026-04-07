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
}