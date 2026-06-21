/** Telegram channel: grammy bot lifecycle, auth gate, prompt-driven Claude queries, rate-limited outbound queue. */
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { Logger } from 'pino';
import type { SessionManager } from '../../session/manager.js';
import { resumeSession, startNewSession } from '../../agent/query.js';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { formatSdkEvent, resultFallbackText, splitMessage } from './formatter.js';
import { homedir } from 'os';
import type { LoadedBot } from './bot-store.js';
import { registerCommands, COMMAND_MENU, type BotRuntime } from './commands.js';
import { resolveCwd, ensureSessionForCwd, getErrorMessage, prettyPath, sleep } from './helpers.js';
import { getCurrentCwd, addBot, setCurrentSessionId } from './bot-store.js';
import { getLatestSession, escapeHtml, sessionExistsOnDisk } from '../../session/resolver.js';

const SEND_INTERVAL_MS = 1100;
const CONTEXT_WARN_PCT = 80;

/** Sent when a turn finishes cleanly but never produced an assistant text block, so the bot is never silently "done". */
const NO_TEXT_REPLY_NOTICE =
  '⚠️ This turn finished without a text reply (it may have been truncated, hit the output-token limit, or only ran tools). Resend, or use /new for a fresh session.';

/** Compact token count for display (1234567 -> "1.2M", 152000 -> "152K"). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Owns one Telegram bot instance and routes its messages to Claude via the SDK. */
export class TelegramBot {
  private readonly bot: Bot;
  private readonly botConfig: LoadedBot;
  private readonly spawnBot?: (bot: LoadedBot) => Promise<void>;
  private readonly sessionManager: SessionManager;
  private readonly logger: Logger;
  private readonly runtime: BotRuntime;
  private outboundQueue: Promise<unknown> = Promise.resolve();
  private lastSentAt = 0;

  constructor(
    botConfig: LoadedBot,
    sessionManager: SessionManager,
    logger: Logger,
    spawnBot?: (bot: LoadedBot) => Promise<void>,
  ) {
    this.botConfig = botConfig;
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.spawnBot = spawnBot;
    this.runtime = {
      botId: botConfig.guid,
      cwd: this.initialCwd(botConfig),
      lastActivityAt: 0,
      awaitingNewBotToken: false,
      highContextWarned: false,
    };
    this.bot = new Bot(botConfig.token);
    this.installAuthGate();
    registerCommands(this.bot, {
      sessionManager: this.sessionManager,
      runtime: this.runtime,
      reply: (ctx, text, keyboard) => this.reply(ctx, text, keyboard),
    });
    this.bot.on('message:text', (ctx) => this.handlePrompt(ctx));
  }

  /** Starts long polling. Returns once polling is initiated (does not block until shutdown). */
  async start(): Promise<void> {
    this.bot.catch((err) => {
      this.logger.error({ err: err.error }, 'Telegram bot error');
    });
    try {
      await this.bot.api.setMyCommands([...COMMAND_MENU]);
    } catch (err: unknown) {
      this.logger.warn({ err }, 'Failed to register command menu (setMyCommands)');
    }
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
      if (ctx.from?.id !== this.botConfig.allowedUserId) {
        this.logger.warn(
          { userId: ctx.from?.id },
          'Rejected Telegram message from unauthorized user',
        );
        return;
      }
      await next();
    });
  }

  /** Picks startup cwd: persisted state if valid, else config default. */
  private initialCwd(botConfig: LoadedBot): string {
    const saved = getCurrentCwd(botConfig.guid);
    if (saved) {
      try {
        return resolveCwd(saved);
      } catch (err: unknown) {
        this.logger.warn(
          { saved, err: err instanceof Error ? err.message : err },
          'Saved cwd is invalid; falling back to the bot default',
        );
      }
    }
    return resolveCwd(botConfig.cwd ?? homedir());
  }

  /** Handles a non-command text message: resume-or-create session for cwd, stream events back. */
  private async handlePrompt(ctx: Context): Promise<void> {
    const prompt = ctx.message?.text;
    if (!prompt) return;

    if (this.runtime.awaitingNewBotToken) {
      this.runtime.awaitingNewBotToken = false;
      if (prompt.startsWith('/')) {
        await this.reply(ctx, 'Onboarding cancelled.');
        return;
      }
      await this.handleNewBotToken(ctx, prompt.trim());
      return;
    }

    if (prompt.startsWith('/')) return;

    this.runtime.lastActivityAt = Date.now();
    const cwd = this.runtime.cwd;

    const ensured = ensureSessionForCwd(this.runtime.botId, cwd);
    const sessionId = ensured.sessionId;
    // Resume only when a JSONL transcript actually exists for this id. A session
    // minted by /new (or a /cd into an empty dir) is persisted but unstarted —
    // resuming it makes the CLI throw "No conversation found", so start it fresh.
    const isResume = !ensured.created && sessionExistsOnDisk(sessionId);

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
    let sawText = false;
    let sawError = false;
    let resultText: string | undefined;
    try {
      for await (const event of handle.generator) {
        const chunks = formatSdkEvent(event);
        for (const chunk of chunks) {
          if (chunk.kind === 'text') sawText = true;
          else if (chunk.kind === 'error') sawError = true;
          await this.enqueueSend(ctx, chunk.text);
        }
        resultText = resultFallbackText(event) ?? resultText;
      }
      // Nothing streamed and no error surfaced ⇒ recover the final answer from the
      // result event if it carried one; otherwise tell the user the turn was empty.
      if (!sawText && !sawError) {
        await this.enqueueSend(ctx, resultText ?? NO_TEXT_REPLY_NOTICE);
      }
      await this.warnIfContextHigh(ctx, handle.generator);
    } catch (err: unknown) {
      if (abortController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        // Intentional abort (via /abort, a superseding query, or shutdown) — not a real error.
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

  /** Validates a pasted bot token (via getMe), stores it as a new bot, and seeds its state (cwd=~, latest session). */
  private async handleNewBotToken(ctx: Context, token: string): Promise<void> {
    let username: string | undefined;
    try {
      const me = await new Bot(token).api.getMe();
      username = me.username;
    } catch (err: unknown) {
      await this.reply(ctx, `❌ That token didn't work (getMe failed): ${escapeHtml(getErrorMessage(err))}`);
      return;
    }
    const home = homedir();
    const record = addBot({ token, allowedUserId: this.botConfig.allowedUserId, cwd: home, name: username });
    try {
      const latest = await getLatestSession(home);
      if (latest) setCurrentSessionId(record.guid, home, latest.sessionId);
    } catch {
      // no sessions in ~ yet — the first message will start one
    }
    if (this.spawnBot) {
      try {
        await this.spawnBot({ ...record, token });
      } catch (err: unknown) {
        await this.reply(ctx, `⚠️ Saved, but couldn't start it live: ${escapeHtml(getErrorMessage(err))}\nA restart will bring it online.`);
        return;
      }
      await this.reply(ctx, [
        `✅ <b>Bot @${escapeHtml(username ?? '?')} is live.</b>`,
        `📁 cwd: <code>${escapeHtml(prettyPath(home))}</code>`,
        'Message it directly — no restart needed.',
      ].join('\n'));
      return;
    }
    await this.reply(ctx, [
      `✅ <b>Bot @${escapeHtml(username ?? '?')} onboarded.</b>`,
      `📁 cwd: <code>${escapeHtml(prettyPath(home))}</code>`,
      'Restart ClaudeBridge to bring it online.',
    ].join('\n'));
  }

  /** After a turn, warns once when the context window crosses CONTEXT_WARN_PCT; re-arms when it drops back. */
  private async warnIfContextHigh(ctx: Context, generator: Query): Promise<void> {
    let usage: Awaited<ReturnType<Query['getContextUsage']>>;
    try {
      usage = await generator.getContextUsage();
    } catch (err: unknown) {
      this.logger.debug({ err }, 'getContextUsage unavailable');
      return;
    }
    if (usage.percentage <= CONTEXT_WARN_PCT) {
      this.runtime.highContextWarned = false;
      return;
    }
    if (this.runtime.highContextWarned) return;
    this.runtime.highContextWarned = true;
    await this.enqueueSend(
      ctx,
      `⚠️ <b>Context ${Math.round(usage.percentage)}% full</b> (${fmtTokens(usage.totalTokens)} / ${fmtTokens(usage.maxTokens)}). Reliability drops near the limit — use /new for a fresh session.`,
      true,
    );
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

  private async reply(ctx: Context, text: string, keyboard?: InlineKeyboard): Promise<void> {
    await this.enqueueSend(ctx, text, true, keyboard);
  }

  /** Serializes outbound messages and enforces Telegram's ~1 msg/sec rate limit; a keyboard rides on the last part. */
  private enqueueSend(ctx: Context, text: string, html = false, keyboard?: InlineKeyboard): Promise<void> {
    const send = async (): Promise<void> => {
      const parts = splitMessage(text);
      for (let i = 0; i < parts.length; i++) {
        const elapsed = Date.now() - this.lastSentAt;
        if (elapsed < SEND_INTERVAL_MS) {
          await sleep(SEND_INTERVAL_MS - elapsed);
        }
        const isLast = i === parts.length - 1;
        const options = {
          ...(html ? { parse_mode: 'HTML' as const } : {}),
          ...(isLast && keyboard ? { reply_markup: keyboard } : {}),
        };
        try {
          await ctx.reply(parts[i], Object.keys(options).length > 0 ? options : undefined);
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
