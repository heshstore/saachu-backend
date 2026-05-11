export const DEDUP = {
  PHONE_WINDOW_MINUTES: 5,
};

export const IDEMPOTENCY = {
  KEY_WINDOW_HOURS: 6,
};

export interface AppConfig {
  companyName: string;
  companyState: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  companyWebsite: string;
  companyGstin: string;
  paymentTerms: string;
  bankAccountName: string;
  bankName: string;
  bankBranch: string;
  bankAccount: string;
  bankIfsc: string;
  bankUpiId: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  shopifyStore: string;
  shopifyToken: string;
  shopifyWebhookSecret: string;
  googlePlacesKey: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  idempotencyWindowSeconds: number;
  // CRM integrations
  indiaMartApiKey: string;
  indiaMartSecretKey: string;
  metaVerifyToken: string;
  metaAccessToken: string;
  metaAppSecret: string;
  metaPageId: string;
  whatsappSessionName: string;
}

export const appConfig: AppConfig = {
  companyName:    process.env.COMPANY_NAME    || 'Saachu',
  companyState:   process.env.COMPANY_STATE   || 'Tamil Nadu',
  companyAddress: process.env.COMPANY_ADDRESS || '',
  companyPhone:   process.env.COMPANY_PHONE   || '',
  companyEmail:   process.env.COMPANY_EMAIL   || '',
  companyWebsite: process.env.COMPANY_WEBSITE || '',
  companyGstin:   process.env.COMPANY_GSTIN   || '',
  paymentTerms:   process.env.PAYMENT_TERMS   || '70% Advance & 30% Before Delivery',
  bankAccountName: process.env.BANK_ACCOUNT_NAME || '',
  bankName:        process.env.BANK_NAME         || '',
  bankBranch:      process.env.BANK_BRANCH       || '',
  bankAccount:     process.env.BANK_ACCOUNT      || '',
  bankIfsc:        process.env.BANK_IFSC         || '',
  bankUpiId:       process.env.BANK_UPI          || '',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  shopifyStore: process.env.SHOPIFY_STORE || '',
  shopifyToken: process.env.SHOPIFY_ACCESS_TOKEN || '',
  shopifyWebhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
  googlePlacesKey: process.env.GOOGLE_PLACES_KEY || '',
  jwtSecret: process.env.JWT_SECRET || 'saachu_jwt_secret_change_in_production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  idempotencyWindowSeconds: 60,
  indiaMartApiKey: process.env.INDIAMART_API_KEY || '',
  indiaMartSecretKey: process.env.INDIAMART_SECRET_KEY || '',
  metaVerifyToken: process.env.META_VERIFY_TOKEN || '',
  metaAccessToken: process.env.META_ACCESS_TOKEN || '',
  metaAppSecret: process.env.META_APP_SECRET || '',
  metaPageId: process.env.META_PAGE_ID || '',
  whatsappSessionName: process.env.WHATSAPP_SESSION || 'saachu-main',
};
