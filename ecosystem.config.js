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
        // Set CHROME_PATH here if google-chrome-stable is not at the default path.
        // Default (/usr/bin/google-chrome-stable) works after: apt install google-chrome-stable
        // CHROME_PATH: '/usr/bin/google-chrome-stable',

        // Phase 8 — Production Pilot (real audience, tighter limits, pilot safety active)
        WHATSAPP_ENGINE_ENABLED: 'true',
        WHATSAPP_ENGINE_DRY_RUN: 'false',
        WHATSAPP_ENGINE_TEST_ONLY: 'false',
        WHATSAPP_ENGINE_PILOT_MODE: 'true',
        WHATSAPP_ENGINE_MAX_DAILY_AUDIENCE: '25',
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
