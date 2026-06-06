module.exports = {
  apps: [
    {
      name: 'saachu-backend',
      script: 'dist/main.js',
      instances: 1,           // MUST be 1 — WhatsApp singleton requires a single process
      exec_mode: 'fork',      // NOT cluster — Puppeteer + LocalAuth are not cluster-safe
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',

      env_production: {
        NODE_ENV: 'production',
        PORT: 4000,
        TZ: 'Asia/Kolkata',
        // Set CHROME_PATH here if google-chrome-stable is not at the default path.
        // Default (/usr/bin/google-chrome-stable) works after: apt install google-chrome-stable
        // CHROME_PATH: '/usr/bin/google-chrome-stable',

        // ── Shopify integration ────────────────────────────────────────────────
        // REQUIRED for Shopify catalog sync. These vars are NOT in .env (gitignored).
        // Set them here OR export them as system env vars before running pm2 start.
        // Without these, sync endpoints return "Shopify not configured" and the
        // dashboard chip shows a warning instead of crashing.
        //
        // SHOPIFY_STORE: 'your-store.myshopify.com',       // ← uncomment + fill
        // SHOPIFY_ACCESS_TOKEN: 'shpat_xxxxxxxxxxxx',      // ← uncomment + fill

        // Phase 8 — Connection Testing (TEST_ONLY=true, flip to false at pilot go-live)
        WHATSAPP_ENGINE_ENABLED: 'true',
        WHATSAPP_ENGINE_DRY_RUN: 'false',
        WHATSAPP_ENGINE_TEST_ONLY: 'false',
        WHATSAPP_ENGINE_PILOT_MODE: 'true',
        WHATSAPP_ENGINE_MAX_DAILY_AUDIENCE: '25',
        MARKETING_TEST_BYPASS_SEND_WINDOW: 'false',
      },

      // Logs
      out_file:   './logs/pm2-out.log',
      error_file: './logs/pm2-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Restart policy
      restart_delay:  5000,   // 5 s between crash restarts (give Chrome time to exit)
      min_uptime:     5000,   // must stay up 5 s to count as stable
      max_restarts:     10,   // stop retrying after 10 rapid crashes
    },
  ],
};
