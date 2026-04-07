export class CreateOrderDto {
  customer_name: string;
  customer_address: string;
  customer_phone: string;
  customer_gst: string;

  // 🔥 ADD THESE 2
  heshAmount: number;
  saachuAmount: number;

  items: {
    itemName: string;
    qty: number;

    mspPrice: number;

    discountAmount?: number;
    discountPercent?: number;
  }[];

  sales_person_id?: number;
}