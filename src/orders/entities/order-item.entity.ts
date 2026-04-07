import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { Order } from './order.entity';

@Entity()
export class OrderItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  itemName: string;

  @Column()
  quantity: number;

  // 🔥 NEW FIELDS (VERY IMPORTANT)
  @Column('float')
  msp_price: number;

  @Column('float', { default: 0 })
  discount_amount: number;

  @Column('float', { default: 0 })
  discount_percent: number;

  // ✅ FINAL VALUES
  @Column('float')
  rate: number;

  @Column('float')
  amount: number;

  // ✅ OPTIONAL (already in your code)
  @Column({ default: 'stock' })
  item_type: string;

  @Column({ default: 'pending' })
  status: string;

  @Column({ nullable: true })
  productId: string;

  // 🔗 RELATION
  @ManyToOne(() => Order, (order) => order.items, {
    onDelete: 'CASCADE',
  })
  order: Order;

  @Column({ nullable: true })
  image: string;

  @Column({ default: true })
  isActive: boolean;
}


