import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Req,
  Param,
  Query,
} from '@nestjs/common';
import { DispatchService } from './dispatch.service';
import { DispatchOrdersService } from './dispatch-orders.service';
import { CreateDispatchDto } from './dto/create-dispatch.dto';
import { MarkDeliveredDto } from './dto/mark-delivered.dto';
import { RequirePermission } from '../auth/require-permission.decorator';
import { DispatchPermission as DP } from './dispatch-permission.enum';

@Controller('dispatch')
export class DispatchController {
  constructor(
    private readonly service: DispatchService,
    private readonly dispatchOrders: DispatchOrdersService,
  ) {}

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
    const { dispatch, orderUpdated } = await this.service.markDelivered(
      dto,
      req.user?.id,
    );
    const response: Record<string, any> = { ...dispatch };
    if (!orderUpdated) {
      response.warning =
        'Delivery recorded, but the order was not closed — it may have been cancelled before delivery was confirmed.';
    }
    return response;
  }

  // ── Dispatch orders (multi-line, ledger-backed) ─────────────────────────────

  @Get('orders')
  @RequirePermission(DP.VIEW)
  listDispatchOrders(@Query('orderId') orderId?: string) {
    return this.dispatchOrders.findDispatchOrders(
      orderId ? +orderId : undefined,
    );
  }

  @Get('orders/:id/pick-list')
  @RequirePermission(DP.VIEW)
  pickList(@Param('id') id: string) {
    return this.dispatchOrders.findDispatchOrderById(+id);
  }

  @Get('orders/:id')
  @RequirePermission(DP.VIEW)
  getDispatchOrder(@Param('id') id: string) {
    return this.dispatchOrders.findDispatchOrderById(+id);
  }

  @Post('orders')
  @RequirePermission(DP.CREATE)
  createDispatchOrder(@Body() body: { orderId: number }, @Req() req: any) {
    return this.dispatchOrders.createDraftFromOrder(
      +body.orderId,
      req.user?.id,
    );
  }

  @Patch('orders/:id')
  @RequirePermission(DP.CREATE)
  patchDispatchOrder(
    @Param('id') id: string,
    @Body()
    body: {
      remarks?: string;
      transporterName?: string;
      lrNumber?: string;
      trackingNumber?: string;
      status?: 'DRAFT' | 'READY';
      packingCost?: number;
      logisticsCost?: number;
      miscCost?: number;
    },
  ) {
    return this.dispatchOrders.updateHeader(+id, body);
  }

  @Patch('orders/:id/lines/:lineId')
  @RequirePermission(DP.CREATE)
  packLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body()
    body: { packedQty: number; packingRemarks?: string; cartonCount?: number },
    @Req() req: any,
  ) {
    return this.dispatchOrders.packLine(+id, +lineId, body, req.user?.id);
  }

  @Post('orders/:id/confirm-dispatch')
  @RequirePermission(DP.CREATE)
  confirmDispatch(@Param('id') id: string, @Req() req: any) {
    return this.dispatchOrders.confirmDispatch(+id, req.user?.id);
  }

  @Post('orders/:id/in-transit')
  @RequirePermission(DP.CREATE)
  inTransit(
    @Param('id') id: string,
    @Body()
    body: {
      transporterName?: string;
      lrNumber?: string;
      trackingNumber?: string;
    },
  ) {
    return this.dispatchOrders.markInTransit(+id, body);
  }

  @Post('orders/:id/delivery')
  @RequirePermission(DP.DELIVER)
  delivery(
    @Param('id') id: string,
    @Body() body: { lines: { id: number; deliveredQty: number }[] },
    @Req() req: any,
  ) {
    return this.dispatchOrders.updateDelivery(+id, body, req.user?.id);
  }

  @Post('orders/:id/cancel')
  @RequirePermission(DP.CREATE)
  cancelDraft(@Param('id') id: string) {
    return this.dispatchOrders.cancelDraft(+id);
  }
}
