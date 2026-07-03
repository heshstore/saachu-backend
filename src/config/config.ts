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
  googleAdsWebhookKey: string;
  whatsappSessionName: string;
  publicAppUrl: string;
  emailFromName: string;
  emailSignoffName: string;
  companyFactoryAddress: string;
  companyOfficeAddress: string;
  socialFacebookUrl: string;
  socialInstagramUrl: string;
  socialLinkedinUrl: string;
  socialPinterestUrl: string;
  socialYoutubeUrl: string;
}

export const appConfig: AppConfig = {
  companyName: process.env.COMPANY_NAME || 'Saachu',
  companyState: process.env.COMPANY_STATE || 'Tamil Nadu',
  companyAddress: process.env.COMPANY_ADDRESS || '',
  companyPhone: process.env.COMPANY_PHONE || '',
  companyEmail: process.env.COMPANY_EMAIL || '',
  companyWebsite: process.env.COMPANY_WEBSITE || '',
  companyGstin: process.env.COMPANY_GSTIN || '',
  paymentTerms:
    process.env.PAYMENT_TERMS || '70% Advance & 30% Before Delivery',
  bankAccountName: process.env.BANK_ACCOUNT_NAME || '',
  bankName: process.env.BANK_NAME || '',
  bankBranch: process.env.BANK_BRANCH || '',
  bankAccount: process.env.BANK_ACCOUNT || '',
  bankIfsc: process.env.BANK_IFSC || '',
  bankUpiId: process.env.BANK_UPI || '',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  shopifyStore: process.env.SHOPIFY_STORE || '',
  shopifyToken: process.env.SHOPIFY_ACCESS_TOKEN || '',
  shopifyWebhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
  googlePlacesKey: process.env.GOOGLE_PLACES_KEY || '',
  jwtSecret: (() => {
    const s = process.env.JWT_SECRET;
    if (!s && process.env.NODE_ENV === 'production')
      throw new Error('[FATAL] JWT_SECRET must be set in production.');
    return s || 'saachu_jwt_secret_dev_only';
  })(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  idempotencyWindowSeconds: 60,
  indiaMartApiKey: process.env.INDIAMART_API_KEY || '',
  indiaMartSecretKey: process.env.INDIAMART_SECRET_KEY || '',
  metaVerifyToken: process.env.META_VERIFY_TOKEN || '',
  metaAccessToken: process.env.META_ACCESS_TOKEN || '',
  metaAppSecret: process.env.META_APP_SECRET || '',
  metaPageId: process.env.META_PAGE_ID || '',
  googleAdsWebhookKey: process.env.GOOGLE_ADS_WEBHOOK_KEY || '',
  whatsappSessionName: process.env.WHATSAPP_SESSION || 'saachu-main',
  publicAppUrl: (process.env.PUBLIC_APP_URL || '').replace(/\/$/, ''),
  emailFromName: process.env.EMAIL_FROM_NAME || 'HeshStore.in',
  emailSignoffName: process.env.EMAIL_SIGNOFF_NAME || 'Hesh Team',
  companyFactoryAddress: process.env.COMPANY_FACTORY_ADDRESS || '',
  companyOfficeAddress: process.env.COMPANY_OFFICE_ADDRESS || '',
  socialFacebookUrl: process.env.SOCIAL_FACEBOOK_URL || '',
  socialInstagramUrl: process.env.SOCIAL_INSTAGRAM_URL || '',
  socialLinkedinUrl: process.env.SOCIAL_LINKEDIN_URL || '',
  socialPinterestUrl: process.env.SOCIAL_PINTEREST_URL || '',
  socialYoutubeUrl: process.env.SOCIAL_YOUTUBE_URL || '',
};
