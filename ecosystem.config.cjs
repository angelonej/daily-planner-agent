// PM2 process manager config
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 restart planner
//   pm2 logs planner
//   pm2 monit

module.exports = {
  apps: [
    {
      name: "planner",
      script: "./dist/index.js",
      interpreter: "node",

      // Restart automatically if it crashes
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 3000,

      // Log files (on EC2 these go to ~/.pm2/logs/ by default)
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",

      // Environment — PM2 reads these so you don't need to export them manually
      // On EC2, fill these in or point to your .env file using --env-file flag
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
    },
  ],
};
