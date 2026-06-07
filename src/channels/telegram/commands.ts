/** Telegram /command handlers — /pwd /cd /attach /list /new /whoami /abort /reset /status /start /help. */
import type { Bot, Context } from 'grammy';
import { randomUUID } from 'crypto';
import type { SessionManager } from '../../session/manager.js';
import {
  getCurrentSessionId,
  setCurrentSessionId,
  clearCurrentSessionId,
} from '../../session/state.js';
import {
  resolveSession,
  getLatestSession,
  listAllSessions,
  describeSession,
  describeSessionById,
  escapeHtml,
} from '../../session/resolver.js';
import {
  CHANNEL,
  resolveCwd,
  getErrorMessage,
  getActiveSessionIdForCwd,
  isBusy,
  attachOrCreateForCwd,
} from './helpers.js';

export interface BotRuntime {
  cwd: string;
  lastActivityAt: number;
}

export interface CommandDeps {
  sessionManager: SessionManager;
  runtime: BotRuntime;
  reply: (ctx: Context, text: string) => Promise<void>;
}

/** Wires all /command handlers onto the bot; deps are shared with TelegramBot's runtime + reply queue. */
export function registerCommands(bot: Bot, deps: CommandDeps): void {
  bot.command('start', (ctx) => handleStart(ctx, deps));
  bot.command('help', (ctx) => handleHelp(ctx, deps));
  bot.command('status', (ctx) => handleStatus(ctx, deps));
  bot.command('pwd', (ctx) => handlePwd(ctx, deps));
  bot.command('cd', (ctx) => handleCd(ctx, deps));
  bot.command('attach', (ctx) => handleAttach(ctx, deps));
  bot.command('list', (ctx) => handleList(ctx, deps));
  bot.command('new', (ctx) => handleNew(ctx, deps));
  bot.command('whoami', (ctx) => handleWhoami(ctx, deps));
  bot.command('abort', (ctx) => handleAbort(ctx, deps));
  bot.command('reset', (ctx) => handleReset(ctx, deps));
}

async function handleStart(ctx: Context, { runtime, reply }: CommandDeps): Promise<void> {
  await reply(ctx, [
    '🌉 <b>ClaudeBridge ready.</b>',
    '',
    `Working directory: <code>${escapeHtml(runtime.cwd)}</code>`,
    '',
    'Send any message to talk to Claude.',
    'Use /help to see available commands.',
  ].join('\n'));
}

async function handleHelp(ctx: Context, { reply }: CommandDeps): Promise<void> {
  await reply(ctx, [
    '<b>Commands:</b>',
    '/pwd — show current working directory',
    '/cd &lt;path&gt; — switch working directory (absolute, ~/, or relative)',
    '/whoami — show current session ID and alias',
    '/list — list sessions in current cwd',
    '/attach [id|alias] — attach to a session (latest if omitted)',
    '/new — start a new session in current cwd',
    '/status — show running status',
    '/abort — cancel the running query',
    '/reset — forget current session (next message starts fresh)',
    '/help — show this message',
    '',
    'Any other text is sent to Claude as a prompt.',
  ].join('\n'));
}

async function handleStatus(ctx: Context, { sessionManager, runtime, reply }: CommandDeps): Promise<void> {
  const isRunning = isBusy(sessionManager, runtime.cwd);
  const last = runtime.lastActivityAt
    ? new Date(runtime.lastActivityAt).toISOString()
    : 'never';
  const current = getCurrentSessionId(CHANNEL, runtime.cwd);
  await reply(ctx, [
    `<b>Cwd:</b> <code>${escapeHtml(runtime.cwd)}</code>`,
    `<b>Session:</b> ${current ? `<code>${current.slice(0, 8)}</code>` : '(none)'}`,
    `<b>Running:</b> ${isRunning ? 'yes' : 'no'}`,
    `<b>Last activity:</b> ${last}`,
  ].join('\n'));
}

async function handlePwd(ctx: Context, { runtime, reply }: CommandDeps): Promise<void> {
  await reply(ctx, `<code>${escapeHtml(runtime.cwd)}</code>`);
}

async function handleCd(ctx: Context, { sessionManager, runtime, reply }: CommandDeps): Promise<void> {
  const arg = ctx.message?.text?.split(/\s+/, 2)[1]?.trim();
  if (!arg) {
    await reply(ctx, 'Usage: /cd &lt;path&gt;');
    return;
  }
  if (isBusy(sessionManager, runtime.cwd)) {
    await reply(ctx, 'Cannot change cwd while a query is running. Use /abort first.');
    return;
  }
  let target: string;
  try {
    target = resolveCwd(arg, runtime.cwd);
  } catch (err: unknown) {
    await reply(ctx, `❌ ${escapeHtml(getErrorMessage(err))}`);
    return;
  }
  runtime.cwd = target;
  const attached = await attachOrCreateForCwd(target);
  const desc = await describeSessionById(attached.sessionId, target);
  const prefix =
    attached.kind === 'remembered'
      ? 'session'
      : attached.kind === 'attached-latest'
        ? 'attached latest'
        : 'new session';
  await reply(ctx, `Switched to <code>${escapeHtml(target)}</code>\n<b>${prefix}:</b> ${desc}`);
}

async function handleAttach(ctx: Context, { sessionManager, runtime, reply }: CommandDeps): Promise<void> {
  if (isBusy(sessionManager, runtime.cwd)) {
    await reply(ctx, 'Cannot attach while a query is running. Use /abort first.');
    return;
  }
  const arg = ctx.message?.text?.split(/\s+/, 2)[1]?.trim();
  const cwd = runtime.cwd;

  if (!arg) {
    const latest = await getLatestSession(cwd);
    if (!latest) {
      await reply(ctx, 'No sessions found in this cwd. Send a message or use /new to start.');
      return;
    }
    setCurrentSessionId(CHANNEL, cwd, latest.sessionId);
    await reply(ctx, `<b>Attached to latest:</b> ${describeSession(latest)}`);
    return;
  }

  const resolved = await resolveSession(arg, cwd);
  if (!resolved) {
    await reply(ctx, `❌ No session matches "${escapeHtml(arg)}" in <code>${escapeHtml(cwd)}</code>`);
    return;
  }
  setCurrentSessionId(CHANNEL, cwd, resolved.sessionId);
  await reply(ctx, `<b>Attached via ${resolved.matched}:</b> ${describeSession(resolved.info)}`);
}

async function handleList(ctx: Context, { runtime, reply }: CommandDeps): Promise<void> {
  const cwd = runtime.cwd;
  const sessions = await listAllSessions(cwd);
  if (sessions.length === 0) {
    await reply(ctx, `No sessions in <code>${escapeHtml(cwd)}</code>`);
    return;
  }
  const current = getCurrentSessionId(CHANNEL, cwd);
  const lines = [`<b>Sessions in <code>${escapeHtml(cwd)}</code>:</b>`];
  for (const s of sessions.slice(0, 10)) {
    const marker = s.sessionId === current ? '▸' : ' ';
    lines.push(`${marker} ${describeSession(s)}`);
  }
  if (sessions.length > 10) {
    lines.push(`<i>... and ${sessions.length - 10} more</i>`);
  }
  await reply(ctx, lines.join('\n'));
}

async function handleNew(ctx: Context, { sessionManager, runtime, reply }: CommandDeps): Promise<void> {
  if (isBusy(sessionManager, runtime.cwd)) {
    await reply(ctx, 'Cannot create new session while a query is running. Use /abort first.');
    return;
  }
  const newId = randomUUID();
  setCurrentSessionId(CHANNEL, runtime.cwd, newId);
  await reply(ctx, `<b>New session</b> <code>${newId.slice(0, 8)}</code> ready. Send a message to start.`);
}

async function handleWhoami(ctx: Context, { runtime, reply }: CommandDeps): Promise<void> {
  const cwd = runtime.cwd;
  const current = getCurrentSessionId(CHANNEL, cwd);
  if (!current) {
    await reply(ctx, `<b>Cwd:</b> <code>${escapeHtml(cwd)}</code>\n<b>Session:</b> (none — next message will create one)`);
    return;
  }
  const desc = await describeSessionById(current, cwd);
  await reply(ctx, [
    `<b>Cwd:</b> <code>${escapeHtml(cwd)}</code>`,
    `<b>Session:</b> ${desc}`,
    `<b>Full ID:</b> <code>${current}</code>`,
  ].join('\n'));
}

async function handleAbort(ctx: Context, { sessionManager, runtime, reply }: CommandDeps): Promise<void> {
  const sessionId = getActiveSessionIdForCwd(sessionManager, runtime.cwd);
  if (!sessionId) {
    await reply(ctx, 'Nothing to abort.');
    return;
  }
  sessionManager.abort(sessionId);
  await reply(ctx, '🛑 <b>Aborted.</b>');
}

async function handleReset(ctx: Context, { sessionManager, runtime, reply }: CommandDeps): Promise<void> {
  if (isBusy(sessionManager, runtime.cwd)) {
    await reply(ctx, 'Cannot reset while a query is running. Use /abort first.');
    return;
  }
  clearCurrentSessionId(CHANNEL, runtime.cwd);
  await reply(ctx, '✅ <b>Session forgotten.</b> Next message starts fresh.');
}
