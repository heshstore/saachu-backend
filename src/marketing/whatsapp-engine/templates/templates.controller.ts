import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { NumbersService } from '../numbers/numbers.service';
import { PromotionProductSelectionService } from '../promotion/promotion-product-selection.service';
import { PromotionAiTemplateService } from '../promotion/promotion-ai-template.service';

interface GenerateDto {
  telecaller_number_id: string;
  product_id?: number;
  customer: {
    name: string;
    city?: string;
    business_type?: string;
    phone?: string;
  };
  campaign_id?: string;
  category?: string;
  record?: boolean;
}

@Controller('marketing/whatsapp-engine/templates')
export class TemplatesController {
  constructor(
    private readonly templatesService: TemplatesService,
    private readonly numbersService: NumbersService,
    private readonly promotionProductService: PromotionProductSelectionService,
    private readonly promotionAiService: PromotionAiTemplateService,
  ) {}

  @Get()
  findAll() {
    return this.templatesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.templatesService.findOne(id);
  }

  @Post()
  create(@Body() dto: any) {
    return this.templatesService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: any) {
    return this.templatesService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.templatesService.remove(id);
  }

  /**
   * POST /marketing/whatsapp-engine/templates/generate
   *
   * Generates a promotion message for a telecaller + customer combination.
   * If product_id is omitted, picks an eligible product via the 24h rotation window.
   * Pass record=true to persist the product selection into the rotation log.
   */
  @Post('generate')
  async generate(@Body() dto: GenerateDto) {
    if (!dto.telecaller_number_id) {
      throw new BadRequestException('telecaller_number_id is required');
    }
    if (!dto.customer?.name) {
      throw new BadRequestException('customer.name is required');
    }

    const number = await this.numbersService.findOne(dto.telecaller_number_id);

    const product = dto.product_id
      ? await this.promotionProductService.findById(dto.product_id)
      : await this.promotionProductService.getEligibleProductForTelecaller(
          dto.telecaller_number_id,
          { campaignId: dto.campaign_id, category: dto.category},
        );

    if (!product) {
      throw new NotFoundException(
        dto.product_id
          ? `Product ${dto.product_id} not found in catalog`
          : 'No eligible products found in catalog for this telecaller',
      );
    }

    const result = await this.promotionAiService.generate({
      telecaller_number_id: dto.telecaller_number_id,
      telecaller_phone: number.phone,
      product,
      customer: dto.customer,
      campaign_id: dto.campaign_id,
    });

    if (dto.record) {
      await this.promotionProductService.recordProductSent(
        dto.telecaller_number_id,
        product,
        dto.campaign_id,
      );
    }

    return {
      message: result.message,
      metadata: result.metadata,
      product: {
        id: product.id,
        sku: product.sku,
        name: product.itemName,
      },
      telecaller: {
        id: number.id,
        phone: number.phone,
        name: number.name,
      },
    };
  }
}
