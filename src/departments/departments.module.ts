import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Department } from './entities/department.entity';
import { DepartmentExtension } from './entities/department-extension.entity';
import { DepartmentChecklist } from './entities/department-checklist.entity';
import { DepartmentChecklistItem } from './entities/department-checklist-item.entity';
import { DepartmentChecklistSession } from './entities/department-checklist-session.entity';
import { DepartmentChecklistCompletion } from './entities/department-checklist-completion.entity';
import { DepartmentMachine } from './entities/department-machine.entity';
import { DepartmentMaintenance } from './entities/department-maintenance.entity';
import { DepartmentSkill } from './entities/department-skill.entity';
import { DepartmentKpi } from './entities/department-kpi.entity';
import { DepartmentKra } from './entities/department-kra.entity';
import { DepartmentDocument } from './entities/department-document.entity';
import { DepartmentsService } from './departments.service';
import { DepartmentControlService } from './department-control.service';
import { DepartmentsController } from './departments.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Department,
      DepartmentExtension,
      DepartmentChecklist,
      DepartmentChecklistItem,
      DepartmentChecklistSession,
      DepartmentChecklistCompletion,
      DepartmentMachine,
      DepartmentMaintenance,
      DepartmentSkill,
      DepartmentKpi,
      DepartmentKra,
      DepartmentDocument,
    ]),
  ],
  controllers: [DepartmentsController],
  providers: [DepartmentsService, DepartmentControlService],
  exports: [DepartmentsService, DepartmentControlService],
})
export class DepartmentsModule {}
