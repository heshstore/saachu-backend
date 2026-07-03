import { Controller, Get, Post, Body } from '@nestjs/common';
import { ValidateService } from './validate.service';

@Controller('marketing/whatsapp-engine/validate')
export class ValidateController {
  constructor(private readonly validateService: ValidateService) {}

  @Get()
  getReport() {
    return this.validateService.getValidationReport();
  }

  @Get('delivery-flow')
  getDeliveryFlow() {
    return this.validateService.getDeliveryFlow();
  }

  @Post('seed-test-contacts')
  seedTestContacts(
    @Body() body: { contacts: { phone: string; name?: string }[] },
  ) {
    return this.validateService.seedTestContacts(body.contacts ?? []);
  }
}
