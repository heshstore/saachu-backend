import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductionBoardTask } from './entities/production-board-task.entity';
import { ProductionBoardService } from './production-board.service';
import { ProductionBoardController } from './production-board.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ProductionBoardTask])],
  controllers: [ProductionBoardController],
  providers: [ProductionBoardService],
  exports: [ProductionBoardService],
})
export class ProductionBoardModule {}
