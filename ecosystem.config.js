// ecosystem.config.js
// PM2 Configuration for Bug Tool
// Start with: pm2 start ecosystem.config.js

module.exports = {
    apps: [
        // ==================== TELEGRAM BOT ====================
        {
            name: 'bot',
            script: 'index.js',
            cwd: './',
            instances: 1,
            exec_mode: 'fork',
            watch: false,
            autorestart: true,
            max_restarts: 10,
            min_uptime: '30s',
            restart_delay: 5000,
            max_memory_restart: '800M',
            kill_timeout: 10000,
            listen_timeout: 10000,
            shutdown_with_message: false,
            wait_ready: false,

            env: {
                NODE_ENV: 'production',
                TZ: 'Asia/Karachi'
            },

            error_file: './logs/bot-error.log',
            out_file: './logs/bot-out.log',
            log_file: './logs/bot-combined.log',
            time: true,
            merge_logs: true,
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

            // Auto-restart on crash
            exp_backoff_restart_delay: 100,

            // Ignore specific errors
            ignore_watch: [
                'node_modules',
                'logs',
                'Love/auth',
                'Love/data.json',
                '*.log'
            ]
        },

        // ==================== WEB API ====================
        {
            name: 'api',
            script: 'api.js',
            cwd: './',
            instances: 1,
            exec_mode: 'fork',
            watch: false,
            autorestart: true,
            max_restarts: 10,
            min_uptime: '30s',
            restart_delay: 5000,
            max_memory_restart: '500M',
            kill_timeout: 10000,

            env: {
                NODE_ENV: 'production',
                TZ: 'Asia/Karachi',
                PORT: 3000
            },

            error_file: './logs/api-error.log',
            out_file: './logs/api-out.log',
            log_file: './logs/api-combined.log',
            time: true,
            merge_logs: true,
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

            exp_backoff_restart_delay: 100,

            ignore_watch: [
                'node_modules',
                'logs',
                'Love/auth',
                '*.log'
            ]
        }
    ]
};