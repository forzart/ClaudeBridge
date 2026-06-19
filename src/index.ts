/** Entry point: migrates the legacy single-bot config, then starts one TelegramBot per configured bot. */
import { pino } from 'pino';
import { loadConfig } from './config-file.js';
import { SessionManager } from './session/manager.js';
import { TelegramBot } from './channels/telegram/bot.js';
import { loadBots, migrateLegacyConfig } from './channels/telegram/bot-store.js';

async function main(): Promise<void> {
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

  // One-time import of the old ./config.json single-bot setup into the multi-bot store.
  try {
    const legacy = loadConfig();
    if (legacy) {
      const migrated = migrateLegacyConfig({
        botToken: legacy.botToken,
        allowedUserId: legacy.allowedUserId,
        cwd: legacy.cwd,
      });
      if (migrated) logger.info({ guid: migrated.guid }, 'Migrated legacy config.json into the multi-bot store');
    }
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'Ignoring malformed config.json');
  }

  const bots = loadBots();
  if (bots.length === 0) {
    logger.error('No bots configured. Add ./config.json (legacy) or onboard a bot, then restart.');
    process.exit(1);
  }

  const sessionManager = new SessionManager();
  const instances = bots.map((bot) => new TelegramBot(bot, sessionManager, logger));

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    sessionManager.abortAll();
    await Promise.all(instances.map((instance) => instance.stop()));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await Promise.all(instances.map((instance) => instance.start()));
}

main().catch((err: unknown) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
