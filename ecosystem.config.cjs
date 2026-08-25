module.exports = {
  apps: [
    {
      name: "iseol-bot",
      script: "dist/index.js",
      node_args: "--use-system-ca",
      cwd: __dirname,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      exp_backoff_restart_delay: 100,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
