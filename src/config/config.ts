export interface AppConfig {
  companyName: string;
  companyState: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  shopifyStore: string;
  shopifyToken: string;
  googlePlacesKey: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  idempotencyWindowSeconds: number;
}

export const appConfig: AppConfig = {
  companyName: process.env.COMPANY_NAME || 'Saachu',
  companyState: process.env.COMPANY_STATE || 'Maharashtra',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  shopifyStore: process.env.SHOPIFY_STORE || '',
  shopifyToken: process.env.SHOPIFY_ACCESS_TOKEN || '',
  googlePlacesKey: process.env.GOOGLE_PLACES_KEY || '',
  jwtSecret: process.env.JWT_SECRET || 'saachu_jwt_secret_change_in_production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  idempotencyWindowSeconds: 60,
};
