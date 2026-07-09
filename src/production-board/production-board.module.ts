import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductionBoardTask } from './entities/production-board-task.entity';
import { ProductionBoardService } from './production-board.service';
import { ProductionBoardController } from './production-board.controller';
import { DepartmentsModule } from '../departments/departments.module';

@Module({
  imports: [TypeOrmModule.forFeature([ProductionBoardTask]), DepartmentsModule],
  controllers: [ProductionBoardController],
  providers: [ProductionBoardService],
  exports: [ProductionBoardService],
})
export class ProductionBoardModule {}
