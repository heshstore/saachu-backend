import { Controller, Get, Post, Patch, Delete, Body, Param } from '@nestjs/common';
import { BoqService } from './boq.service';

@Controller('boq')
export class BoqController {
  constructor(private readonly svc: BoqService) {}

  @Get('item/:itemId')
  findByItem(@Param('itemId') itemId: string) {
    return this.svc.findByItem(+itemId);
  }

  @Post()
  createBoq(@Body() data: any) {
    return this.svc.createBoq(data);
  }

  @Patch(':id')
  updateBoq(@Param('id') id: string, @Body() data: any) {
    return this.svc.updateBoq(+id, data);
  }

  @Post(':boqId/lines')
  addLine(@Param('boqId') boqId: string, @Body() data: any) {
    return this.svc.addLine(+boqId, data);
  }

  @Patch(':boqId/lines/:lineId')
  updateLine(
    @Param('boqId')  boqId:  string,
    @Param('lineId') lineId: string,
    @Body() data: any,
  ) {
    return this.svc.updateLine(+boqId, +lineId, data);
  }

  @Delete(':boqId/lines/:lineId')
  deleteLine(
    @Param('boqId')  boqId:  string,
    @Param('lineId') lineId: string,
  ) {
    return this.svc.deleteLine(+boqId, +lineId);
  }
}
