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
  // CRM integrations
  indiaMartApiKey: string;
  indiaMartSecretKey: string;
  metaVerifyToken: string;
  metaAccessToken: string;
  metaPageId: string;
  whatsappSessionName: string;
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
  indiaMartApiKey: process.env.INDIAMART_API_KEY || '',
  indiaMartSecretKey: process.env.INDIAMART_SECRET_KEY || '',
  metaVerifyToken: process.env.META_VERIFY_TOKEN || '',
  metaAccessToken: process.env.META_ACCESS_TOKEN || '',
  metaPageId: process.env.META_PAGE_ID || '',
  whatsappSessionName: process.env.WHATSAPP_SESSION || 'saachu-main',
};
