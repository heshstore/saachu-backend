import { IsInt, IsEnum, IsOptional, IsString } from 'class-validator';
import { TransportType } from '../entities/dispatch.entity';

export class CreateDispatchDto {
  @IsInt()
  order_id: number;

  @IsEnum(TransportType)
  transport_type: TransportType;

  @IsOptional()
  @IsString()
  tracking_number?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
