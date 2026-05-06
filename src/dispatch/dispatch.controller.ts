import { Controller, Get, Post, Body, Req } from '@nestjs/common';
import { DispatchService }      from './dispatch.service';
import { CreateDispatchDto }    from './dto/create-dispatch.dto';
import { MarkDeliveredDto }     from './dto/mark-delivered.dto';
import { RequirePermission }    from '../auth/require-permission.decorator';
import { DispatchPermission as DP } from './dispatch-permission.enum';

@Controller('dispatch')
export class DispatchController {
  constructor(private readonly service: DispatchService) {}

  @Get('ready-orders')
  @RequirePermission(DP.VIEW)
  getReadyOrders() {
    return this.service.getReadyOrders();
  }

  @Get()
  @RequirePermission(DP.VIEW)
  findAll() {
    return this.service.findAll();
  }

  @Post('create')
  @RequirePermission(DP.CREATE)
  createDispatch(@Body() dto: CreateDispatchDto, @Req() req: any) {
    return this.service.createDispatch(dto, req.user?.id);
  }

  @Post('mark-delivered')
  @RequirePermission(DP.DELIVER)
  async markDelivered(@Body() dto: MarkDeliveredDto, @Req() req: any) {
    const { dispatch, orderUpdated } = await this.service.markDelivered(dto, req.user?.id);
    const response: Record<string, any> = { ...dispatch };
    if (!orderUpdated) {
      response.warning =
        'Delivery recorded, but the order was not closed — it may have been cancelled before delivery was confirmed.';
    }
    return response;
  }
}
