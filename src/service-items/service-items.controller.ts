import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { ServiceItemsService } from './service-items.service';
import { RequirePermission } from '../auth/require-permission.decorator';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'items');

@Controller('service-items')
export class ServiceItemsController {
  constructor(private readonly svc: ServiceItemsService) {}

  @Post('upload-photo')
  @UseInterceptors(
    FileInterceptor('photo', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          fs.mkdirSync(UPLOAD_DIR, { recursive: true });
          cb(null, UPLOAD_DIR);
        },
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname) || '.jpg';
          cb(
            null,
            `item-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`,
          );
        },
      }),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!/^image\/(jpe?g|png|webp|gif)$/.test(file.mimetype)) {
          cb(new BadRequestException('Only image files are allowed'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadPhoto(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    return { url: `/uploads/items/${file.filename}` };
  }

  @Get()
  findAll() {
    return this.svc.findAll();
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.svc.findById(+id);
  }

  @Post()
  @RequirePermission('item.create')
  create(@Body() data: any) {
    return this.svc.create(data);
  }

  @Patch(':id')
  @RequirePermission('item.edit')
  update(@Param('id') id: string, @Body() data: any) {
    return this.svc.update(+id, data);
  }

  @Delete(':id')
  @RequirePermission('item.edit')
  softDelete(@Param('id') id: string) {
    return this.svc.softDelete(+id);
  }
}
