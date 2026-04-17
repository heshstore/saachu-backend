const LEGACY_ADMIN_ROLES = new Set([
  'master admin',
  'masteradmin',
  'super admin',
  'superadmin',
]);

export function normalizeUserRole(role?: string | null): string {
  const trimmed = String(role || '').trim();
  if (!trimmed) return '';

  if (trimmed.toLowerCase() === 'admin' || LEGACY_ADMIN_ROLES.has(trimmed.toLowerCase())) {
    return 'Admin';
  }

  return trimmed;
}

export function normalizeUserMobile(mobile?: string | null): string | null {
  const trimmed = String(mobile || '').trim();
  if (!trimmed) return null;

  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return trimmed;

  return digits.length > 10 ? digits.slice(-10) : digits;
}
