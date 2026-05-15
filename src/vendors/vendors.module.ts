import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Vendor } from './entities/vendor.entity';
import { VendorItemMapping } from './entities/vendor-item-mapping.entity';
import { VendorsService } from './vendors.service';
import { VendorsController, VendorItemMappingsController } from './vendors.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Vendor, VendorItemMapping])],
  controllers: [VendorsController, VendorItemMappingsController],
  providers: [VendorsService],
  exports: [VendorsService],
})
export class VendorsModule {}
