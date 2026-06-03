import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalEmailLog } from './entities/transactional-email-log.entity';
import { TransactionalEmailService } from './transactional-email.service';
import { TransactionalEmailController } from './transactional-email.controller';

@Module({
  imports: [TypeOrmModule.forFeature([TransactionalEmailLog])],
  controllers: [TransactionalEmailController],
  providers: [TransactionalEmailService],
  exports: [TransactionalEmailService],
})
export class TransactionalEmailModule {}
