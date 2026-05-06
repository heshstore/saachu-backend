import { IsInt } from 'class-validator';

export class MarkDeliveredDto {
  @IsInt()
  dispatch_id: number;
}
