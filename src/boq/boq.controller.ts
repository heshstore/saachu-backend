import { Controller, Get, Post, Patch, Delete, Body, Param } from '@nestjs/common';
import { BoqService } from './boq.service';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('boq')
export class BoqController {
  constructor(private readonly svc: BoqService) {}

  @Get('item/:itemId')
  @RequirePermission('production.view')
  findByItem(@Param('itemId') itemId: string) {
    return this.svc.findByItem(+itemId);
  }

  @Post()
  @RequirePermission('production.update')
  createBoq(@Body() data: any) {
    return this.svc.createBoq(data);
  }

  @Patch(':id')
  @RequirePermission('production.update')
  updateBoq(@Param('id') id: string, @Body() data: any) {
    return this.svc.updateBoq(+id, data);
  }

  @Post(':boqId/lines')
  @RequirePermission('production.update')
  addLine(@Param('boqId') boqId: string, @Body() data: any) {
    return this.svc.addLine(+boqId, data);
  }

  @Patch(':boqId/lines/:lineId')
  @RequirePermission('production.update')
  updateLine(
    @Param('boqId')  boqId:  string,
    @Param('lineId') lineId: string,
    @Body() data: any,
  ) {
    return this.svc.updateLine(+boqId, +lineId, data);
  }

  @Delete(':boqId/lines/:lineId')
  @RequirePermission('production.update')
  deleteLine(
    @Param('boqId')  boqId:  string,
    @Param('lineId') lineId: string,
  ) {
    return this.svc.deleteLine(+boqId, +lineId);
  }
}
