module.exports = { apps: [{ name: 'barname', script: 'server.js', env: { PORT: 3000, NODE_ENV: 'production' }, autorestart: true }] };
