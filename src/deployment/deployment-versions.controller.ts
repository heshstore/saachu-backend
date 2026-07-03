import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Headers,
  Param,
  ForbiddenException,
  ServiceUnavailableException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Public } from '../auth/public.decorator';
import {
  DeploymentVersionsService,
  RegisterDeploymentDto,
} from './deployment-versions.service';

@Controller('deployment-versions')
export class DeploymentVersionsController {
  constructor(private readonly svc: DeploymentVersionsService) {}

  /** All deployment records, newest first. JWT-protected (VersionHistory UI). */
  @Get()
  findAll() {
    return this.svc.findAll();
  }

  /** Single deployment record by version string. JWT-protected. */
  @Get(':version')
  async findOne(@Param('version') version: string) {
    const record = await this.svc.findOne(version);
    if (!record) throw new NotFoundException(`Version ${version} not found`);
    return record;
  }

  /**
   * Rollback readiness report for a specific version.
   * Read-only — inspects DB record, backup_manifest artifact flags, and rollback_available.
   * Does NOT execute rollback. JWT-protected.
   */
  @Get(':version/rollback-readiness')
  rollbackReadiness(@Param('version') version: string) {
    return this.svc.rollbackReadiness(version);
  }

  /**
   * Register a new deployment (PENDING or RELEASED).
   * @Public() — protected by X-Deploy-Secret header derived from JWT_SECRET.
   * Called by deploy.sh via register-deployment.js on VPS after health passes.
   */
  @Public()
  @Post('register')
  register(
    @Body() dto: RegisterDeploymentDto,
    @Headers('x-deploy-secret') secret?: string,
  ) {
    this.checkSecret(secret);
    return this.svc.register(dto);
  }

  /**
   * Update deployment status: PENDING → RELEASED | FAILED | ROLLBACK.
   * @Public() — protected by X-Deploy-Secret header.
   * Called by deploy.sh after git tag remote verification succeeds or fails.
   * Response contains recomputed integrity_hash — deploy.sh verifies fields before continuing.
   */
  @Public()
  @Patch(':version/status')
  updateStatus(
    @Param('version') version: string,
    @Body() body: { status: string; rollback_available?: boolean },
    @Headers('x-deploy-secret') secret?: string,
  ) {
    this.checkSecret(secret);
    return this.svc.updateStatus(version, body.status, body.rollback_available);
  }

  private checkSecret(secret?: string): void {
    const expected = this.resolveDeploySecret();
    if (!expected) {
      throw new ServiceUnavailableException(
        'Deployment registration not configured — set DEPLOY_REGISTRATION_SECRET or JWT_SECRET',
      );
    }
    if (secret !== expected) {
      throw new ForbiddenException('Invalid deploy secret');
    }
  }

  private resolveDeploySecret(): string {
    if (process.env.DEPLOY_REGISTRATION_SECRET) {
      return process.env.DEPLOY_REGISTRATION_SECRET;
    }
    if (process.env.JWT_SECRET) {
      return createHash('sha256')
        .update(process.env.JWT_SECRET + ':deploy-registration')
        .digest('hex')
        .substring(0, 32);
    }
    return '';
  }
}
