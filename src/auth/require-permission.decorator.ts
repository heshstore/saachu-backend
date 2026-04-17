import { SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'permission';
export const RequirePermission = (key: string) => SetMetadata(PERMISSION_KEY, key);
