import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const config = loadConfig();
if (config.mode !== 'development' && !config.apiToken) {
  console.error('PITUBE_API_TOKEN is required (or set PITUBE_MODE=development)');
  process.exit(1);
}
const app = buildApp(config, { logger: { level: process.env.PITUBE_LOG_LEVEL || 'info', redact: ['req.headers.authorization'] } });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => app.close().then(() => process.exit(0)));
}

await app.listen({ host: config.host, port: config.port });
// Start polling once a sign-in exists; the monitor reports `auth_missing` until then.
app.pitube.monitor.start();
// Daily token health check, so a dead sign-in shows up before Sunday morning.
setInterval(() => app.pitube.tokens.check(), 24 * 3600 * 1000).unref();
