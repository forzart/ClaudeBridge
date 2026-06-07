/** Telegram channel: grammy bot lifecycle, auth gate, prompt-driven Claude queries, rate-limited outbound queue. */
import { Bot, type Context } from 'grammy';
import type { Logger } from 'pino';
import type { SessionManager } from '../../session/manager.js';
import { resumeSession, startNewSession } from '../../agent/query.js';
import { formatSdkEvent, splitMessage } from './formatter.js';
import type { Config } from '../../config-file.js';
import { registerCommands, type BotRuntime } from './commands.js';
import { resolveCwd, ensureSessionForCwd, getErrorMessage, sleep } from './helpers.js';

const SEND_INTERVAL_MS = 1100;

/** Owns one Telegram bot instance and routes its messages to Claude via the SDK. */
export class TelegramBot {
  private readonly bot: Bot;
  private readonly config: Config;
  private readonly sessionManager: SessionManager;
  private readonly logger: Logger;
  private readonly runtime: BotRuntime;
  private outboundQueue: Promise<unknown> = Promise.resolve();
  private lastSentAt = 0;

  constructor(config: Config, sessionManager: SessionManager, logger: Logger) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.runtime = {
      cwd: resolveCwd(config.cwd),
      lastActivityAt: 0,
    };
    this.bot = new Bot(config.botToken);
    this.installAuthGate();
    registerCommands(this.bot, {
      sessionManager: this.sessionManager,
      runtime: this.runtime,
      reply: (ctx, text) => this.reply(ctx, text),
    });
    this.bot.on('message:text', (ctx) => this.handlePrompt(ctx));
  }

  /** Starts long polling. Returns once polling is initiated (does not block until shutdown). */
  async start(): Promise<void> {
    this.bot.catch((err) => {
      this.logger.error({ err: err.error }, 'Telegram bot error');
    });
    void this.bot.start({
      onStart: (me) => {
        this.logger.info(
          `ClaudeBridge started as @${me.username}, polling for updates (cwd=${this.runtime.cwd})`,
        );
      },
    });
  }

  /** Stops polling and waits for in-flight handlers to finish. */
  async stop(): Promise<void> {
    await this.bot.stop();
  }

  /** Drops messages whose sender is not the configured allowedUserId. */
  private installAuthGate(): void {
    this.bot.use(async (ctx, next) => {
      if (ctx.from?.id !== this.config.allowedUserId) {
        this.logger.warn(
          { userId: ctx.from?.id },
          'Rejected Telegram message from unauthorized user',
        );
        return;
      }
      await next();
    });
  }

  /** Handles a non-command text message: resume-or-create session for cwd, stream events back. */
  private async handlePrompt(ctx: Context): Promise<void> {
    const prompt = ctx.message?.text;
    if (!prompt || prompt.startsWith('/')) return;

    this.runtime.lastActivityAt = Date.now();
    const cwd = this.runtime.cwd;

    const ensured = ensureSessionForCwd(cwd);
    const sessionId = ensured.sessionId;
    const isResume = !ensured.created;

    if (this.sessionManager.isActive(sessionId)) {
      await this.reply(ctx, 'This session is busy (possibly from another client). /abort to cancel.');
      return;
    }

    const abortController = new AbortController();
    this.sessionManager.register(sessionId, abortController);

    const handle = isResume
      ? resumeSession({ prompt, sessionId, cwd, abortController })
      : startNewSession({ prompt, sessionId, cwd, abortController });

    const stopTyping = this.startTyping(ctx);
    let producedText = false;
    try {
      for await (const event of handle.generator) {
        const chunks = formatSdkEvent(event);
        for (const chunk of chunks) {
          if (chunk.kind === 'text') producedText = true;
          await this.enqueueSend(ctx, chunk.text);
        }
      }
      if (!producedText) {
        await this.enqueueSend(ctx, '✓ Done.');
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // already acknowledged in /abort
      } else {
        this.logger.error({ err }, 'Telegram query failed');
        await this.enqueueSend(ctx, `❌ Error: ${getErrorMessage(err)}`);
      }
    } finally {
      stopTyping();
      this.sessionManager.unregister(sessionId);
      this.runtime.lastActivityAt = Date.now();
    }
  }

  /** Emits "typing" chat action immediately then every 4s; returns a stop function for finally. */
  private startTyping(ctx: Context): () => void {
    const send = (): void => {
      void ctx.replyWithChatAction('typing').catch((err: unknown) => {
        this.logger.debug({ err }, 'sendChatAction failed');
      });
    };
    send();
    const handle = setInterval(send, 4000);
    return () => clearInterval(handle);
  }

  private async reply(ctx: Context, text: string): Promise<void> {
    await this.enqueueSend(ctx, text);
  }

  /** Serializes outbound messages and enforces Telegram's ~1 msg/sec rate limit. */
  private enqueueSend(ctx: Context, text: string): Promise<void> {
    const send = async (): Promise<void> => {
      for (const part of splitMessage(text)) {
        const elapsed = Date.now() - this.lastSentAt;
        if (elapsed < SEND_INTERVAL_MS) {
          await sleep(SEND_INTERVAL_MS - elapsed);
        }
        try {
          await ctx.reply(part);
        } catch (err: unknown) {
          this.logger.error({ err }, 'Telegram sendMessage failed');
        }
        this.lastSentAt = Date.now();
      }
    };
    this.outboundQueue = this.outboundQueue.then(send, send);
    return this.outboundQueue as Promise<void>;
  }
}
