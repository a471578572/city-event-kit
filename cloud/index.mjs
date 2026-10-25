import { createPostgresStore } from './store.mjs';
import { createServer, normalizeConfig } from './server.mjs';

try {
  const config = normalizeConfig({
    adminToken: process.env.AWARDS_ADMIN_TOKEN,
    publicOrigin: process.env.PUBLIC_ORIGIN,
    basePath: process.env.BASE_PATH || '/event',
  });
  const store = await createPostgresStore();
  const server = createServer({ store, ...config });
  server.listen(9000, '0.0.0.0', () => console.log('AWARDS_HTTP_READY'));
  server.on('error', () => { console.error('AWARDS_HTTP_FAILED'); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
} catch {
  // Configuration, credentials, payloads, and SDK error bodies must not enter logs.
  console.error('AWARDS_START_FAILED');
  process.exitCode = 1;
}
