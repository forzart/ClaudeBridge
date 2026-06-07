/** Entry point: loads config, wires SessionManager + TelegramBot, handles SIGINT/SIGTERM. */
import { pino } from 'pino';
import { loadConfig } from './config-file.js';
import { SessionManager } from './session/manager.js';
import { TelegramBot } from './channels/telegram/bot.js';

async function main(): Promise<void> {
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

  let config;
  try {
    config = loadConfig();
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'Failed to load config');
    process.exit(1);
  }

  const sessionManager = new SessionManager();
  const bot = new TelegramBot(config, sessionManager, logger);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    sessionManager.abortAll();
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.start();
}

main().catch((err: unknown) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
