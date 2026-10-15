import { Logger } from '@nestjs/common';
import { createApp } from './app';
import { loadConfig } from './config';

async function main() {
  const cfg = loadConfig();
  const app = await createApp(cfg);
  app.enableShutdownHooks();
  await app.listen(cfg.port, '0.0.0.0');
  new Logger('Main').log(`Oxide Bot Monitor on http://localhost:${cfg.port} (dashboard /, API docs /docs)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
