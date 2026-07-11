/** Telegram /command handlers — /pwd /cd /session /new /whoami /abort /reset /status /start /help + inline-button callbacks. */
import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { randomUUID } from 'crypto';
import type { SessionManager } from '../../session/manager.js';
import {
  getCurrentSessionId,
  setCurrentSessionId,
  setCurrentCwd,
  getKnownCwds,
} from './bot-store.js';
import {
  listAllSessions,
  formatSessionList,
  formatSessionDetail,
  formatSessionTableById,
  formatTranscriptChunks,
  sessionInfoToRow,
  escapeHtml,
  sessionExistsOnDisk,
} from '../../session/resolver.js';
import {
  resolveCwd,
  prettyPath,
  getErrorMessage,
  getActiveSessionIdForCwd,
  isBusy,
  attachOrCreateForCwd,
  fmtTokens,
} from './helpers.js';
import { fetchContextUsage } from '../../agent/query.js';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { TurnCoordinator } from './coordinator.js';

export interface BotRuntime {
  botId: string;
  cwd: string;
  lastActivityAt: number;
  awaitingNewBotToken: boolean;
  highContextWarned: boolean;
}

export interface CommandDeps {
  sessionManager: SessionManager;
  coordinator: TurnCoordinator;
  runtime: BotRuntime;
  reply: (ctx: Context, text: string, keyboard?: InlineKeyboard) => Promise<void>;
}

/** Single source of truth for the command list: drives both /help and Telegram's `/` autocomplete menu (setMyCommands). */
export const COMMAND_MENU: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'pwd', description: 'Show current working directory' },
  { command: 'cd', description: 'Switch directory (no arg shows a picker)' },
  { command: 'session', description: 'List sessions; tap one to switch' },
  { command: 'new', description: 'Start a new session in current cwd' },
  { command: 'whoami', description: 'Show current directory + session + status' },
  { command: 'ctx', description: 'Show context-window usage' },
  { command: 'abort', description: 'Cancel the running query' },
  { command: 'newbot', description: 'Onboard a new Telegram bot' },
  { command: 'help', description: 'Show available commands' },
];

/** Wires all /command handlers onto the bot; deps are shared with TelegramBot's runtime + reply queue. */
export function registerCommands(bot: Bot, deps: CommandDeps): void {
  bot.command('start', (ctx) => handleStart(ctx, deps));
  bot.command('help', (ctx) => handleHelp(ctx, deps));
  bot.command('pwd', (ctx) => handlePwd(ctx, deps));
  bot.command('cd', (ctx) => handleCd(ctx, deps));
  bot.command('session', (ctx) => handleSession(ctx, deps));
  bot.command('new', (ctx) => handleNew(ctx, deps));
  bot.command('whoami', (ctx) => handleWhoami(ctx, deps));
  bot.command('ctx', (ctx) => handleCtx(ctx, deps));
  bot.command('abort', (ctx) => handleAbort(ctx, deps));
  bot.command('newbot', (ctx) => handleNewBot(ctx, deps));
  bot.on('callback_query:data', (ctx) => handleCallback(ctx, deps));
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
  const lines = COMMAND_MENU.map((c) => `/${c.command} — ${escapeHtml(c.description)}`);
  await reply(ctx, [
    '<b>Commands:</b>',
    ...lines,
    '',
    'Any other text is sent to Claude as a prompt.',
  ].join('\n'));
}

async function handlePwd(ctx: Context, { runtime, reply }: CommandDeps): Promise<void> {
  await reply(ctx, `<code>${escapeHtml(runtime.cwd)}</code>`);
}

async function handleCd(ctx: Context, deps: CommandDeps): Promise<void> {
  const { sessionManager, runtime, reply } = deps;
  const arg = ctx.message?.text?.split(/\s+/, 2)[1]?.trim();
  if (!arg) {
    await showDirectoryPicker(ctx, deps);
    return;
  }
  if (isBusy(sessionManager, runtime.botId, runtime.cwd)) {
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
  await reply(ctx, await applyCwdSwitch(deps, target));
}

/** Switches runtime to target cwd, attaches latest-or-new session, and returns the confirmation HTML. */
async function applyCwdSwitch(deps: CommandDeps, target: string): Promise<string> {
  deps.runtime.cwd = target;
  setCurrentCwd(deps.runtime.botId, target);
  const attached = await attachOrCreateForCwd(deps.runtime.botId, target);
  const table = await formatSessionTableById(attached.sessionId, target);
  const prefix = attached.kind === 'attached-latest' ? 'attached latest' : 'new session';
  return `Switched to <code>${escapeHtml(target)}</code>\n<b>${prefix}:</b>\n${table}`;
}

/** Renders the known directories as tappable buttons (callback d:&lt;index&gt;); typing /cd &lt;path&gt; still works. */
async function showDirectoryPicker(ctx: Context, { runtime, reply }: CommandDeps): Promise<void> {
  const dirs = getKnownCwds(runtime.botId);
  if (dirs.length === 0) {
    await reply(ctx, 'No known directories yet. Use <code>/cd &lt;path&gt;</code> to switch to one.');
    return;
  }
  const lines = dirs.map((d) => `${d === runtime.cwd ? '▸' : ' '} ${escapeHtml(prettyPath(d))}`);
  const keyboard = new InlineKeyboard();
  dirs.forEach((d, i) => {
    keyboard.text(`${d === runtime.cwd ? '▸ ' : ''}${prettyPath(d)}`, `d:${i}`).row();
  });
  await reply(
    ctx,
    `<b>Switch directory:</b>\n<pre>${lines.join('\n')}</pre>\n<i>or /cd &lt;path&gt; to enter a new one</i>`,
    keyboard,
  );
}

const SESSION_LIMIT = 8;

async function handleSession(ctx: Context, { runtime, reply }: CommandDeps): Promise<void> {
  const cwd = runtime.cwd;
  const sessions = await listAllSessions(cwd);
  if (sessions.length === 0) {
    await reply(ctx, `No sessions in <code>${escapeHtml(cwd)}</code>. Send a message or /new to start.`);
    return;
  }
  const current = getCurrentSessionId(runtime.botId, cwd);
  const visible = sessions.slice(0, SESSION_LIMIT).map((s) => sessionInfoToRow(s, current));
  const list = formatSessionList(visible);
  const header = `<b>Sessions in <code>${escapeHtml(cwd)}</code></b>`;
  const footer = sessions.length > SESSION_LIMIT
    ? `\n\n<i>… and ${sessions.length - SESSION_LIMIT} more</i>`
    : '';
  const keyboard = new InlineKeyboard();
  visible.forEach((row, i) => {
    keyboard
      .text(`${i + 1} ${row.isCurrent ? '▸' : '•'} ${row.sessionId.slice(0, 8)}`, `s:${row.sessionId}`)
      .text('📄 view', `v:${row.sessionId}`)
      .row();
  });
  await reply(ctx, `${header}\n\n${list}${footer}\n\n<b>Switch / view:</b>`, keyboard);
}

/** Routes inline-keyboard taps: session switch (s:&lt;id&gt;), directory switch (d:&lt;index&gt;), and /new + /reset confirmations. */
async function handleCallback(ctx: Context, deps: CommandDeps): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (data?.startsWith('s:')) {
    await switchSessionViaButton(ctx, deps, data.slice(2));
    return;
  }
  if (data?.startsWith('v:')) {
    await viewSessionViaButton(ctx, deps, data.slice(2));
    return;
  }
  if (data?.startsWith('d:')) {
    await switchDirViaButton(ctx, deps, data.slice(2));
    return;
  }
  if (data === 'new:confirm') {
    await confirmNewSession(ctx, deps);
    return;
  }
  if (data === 'newbot:confirm') {
    deps.runtime.awaitingNewBotToken = true;
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, deps, "Send me the new bot's token from @BotFather (or /cancel).");
    return;
  }
  if (data === 'cancel') {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, deps, '✖ Cancelled.');
    return;
  }
  await ctx.answerCallbackQuery();
}

async function switchSessionViaButton(ctx: Context, deps: CommandDeps, sessionId: string): Promise<void> {
  const { sessionManager, runtime } = deps;
  if (isBusy(sessionManager, runtime.botId, runtime.cwd)) {
    await ctx.answerCallbackQuery({ text: 'Claude is busy. /abort first.', show_alert: true });
    return;
  }
  setCurrentSessionId(runtime.botId, runtime.cwd, sessionId);
  await ctx.answerCallbackQuery({ text: 'Switched session' });
  const table = await formatSessionTableById(sessionId, runtime.cwd);
  await editOrReply(ctx, deps, `<b>Switched session:</b>\n${table}`);
}

/** Sends the session's recent transcript as Telegram message(s) — Telegram renders the HTML natively. */
async function viewSessionViaButton(ctx: Context, deps: CommandDeps, sessionId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  const chunks = formatTranscriptChunks(sessionId);
  if (chunks.length === 0) {
    await deps.reply(ctx, 'No conversation to show for this session yet.');
    return;
  }
  for (const chunk of chunks) {
    await deps.reply(ctx, chunk);
  }
}

async function switchDirViaButton(ctx: Context, deps: CommandDeps, indexRaw: string): Promise<void> {
  const { sessionManager, runtime } = deps;
  if (isBusy(sessionManager, runtime.botId, runtime.cwd)) {
    await ctx.answerCallbackQuery({ text: 'Claude is busy. /abort first.', show_alert: true });
    return;
  }
  const dirs = getKnownCwds(runtime.botId);
  const index = Number.parseInt(indexRaw, 10);
  const target = Number.isInteger(index) ? dirs[index] : undefined;
  if (!target) {
    await ctx.answerCallbackQuery({ text: 'List is stale — run /cd again.', show_alert: true });
    return;
  }
  try {
    resolveCwd(target);
  } catch {
    await ctx.answerCallbackQuery({ text: 'Directory no longer exists.', show_alert: true });
    return;
  }
  const text = await applyCwdSwitch(deps, target);
  await ctx.answerCallbackQuery({ text: 'Switched directory' });
  await editOrReply(ctx, deps, text);
}

/** Edits the tapped message in place (dropping its buttons); falls back to a fresh reply on failure. */
async function editOrReply(ctx: Context, deps: CommandDeps, html: string): Promise<void> {
  try {
    await ctx.editMessageText(html, { parse_mode: 'HTML' });
  } catch {
    await deps.reply(ctx, html);
  }
}

async function confirmNewSession(ctx: Context, deps: CommandDeps): Promise<void> {
  const { sessionManager, runtime } = deps;
  if (isBusy(sessionManager, runtime.botId, runtime.cwd)) {
    await ctx.answerCallbackQuery({ text: 'Claude is busy. /abort first.', show_alert: true });
    return;
  }
  const newId = randomUUID();
  setCurrentSessionId(runtime.botId, runtime.cwd, newId);
  await ctx.answerCallbackQuery({ text: 'New session created' });
  await editOrReply(ctx, deps, `✅ <b>New session ready.</b> Send a message to start.\n  <code>${newId}</code>`);
}

async function handleNew(ctx: Context, { sessionManager, runtime, reply }: CommandDeps): Promise<void> {
  if (isBusy(sessionManager, runtime.botId, runtime.cwd)) {
    await reply(ctx, 'Cannot create new session while a query is running. Use /abort first.');
    return;
  }
  const keyboard = new InlineKeyboard()
    .text('✅ New session', 'new:confirm')
    .text('✖ Cancel', 'cancel');
  await reply(ctx, 'Start a <b>new session</b>? The current one stays available via /session.', keyboard);
}

async function handleWhoami(ctx: Context, { sessionManager, runtime, reply }: CommandDeps): Promise<void> {
  const cwd = runtime.cwd;
  const status = isBusy(sessionManager, runtime.botId, cwd) ? '🟢 running…' : '⚪ idle';
  const current = getCurrentSessionId(runtime.botId, cwd);
  if (!current) {
    await reply(ctx, [
      `<b>📁 ${escapeHtml(prettyPath(cwd))}</b>`,
      '',
      'No active session — next message starts a new one.',
      '',
      `<b>Status:</b> ${status}`,
    ].join('\n'));
    return;
  }
  const info = (await listAllSessions(cwd)).find((s) => s.sessionId === current);
  const detail = info
    ? formatSessionDetail(sessionInfoToRow(info, current))
    : `<b>▸ ${current.slice(0, 8)}</b>`;
  await reply(ctx, [
    `<b>📁 ${escapeHtml(prettyPath(cwd))}</b>`,
    '',
    detail,
    `  <code>${current}</code>`,
    '',
    `<b>Status:</b> ${status}`,
  ].join('\n'));
}

async function handleCtx(ctx: Context, { sessionManager, runtime, reply }: CommandDeps): Promise<void> {
  const cwd = runtime.cwd;
  const sessionId = getCurrentSessionId(runtime.botId, cwd);
  if (!sessionId || !sessionExistsOnDisk(sessionId)) {
    await reply(ctx, 'No started session here yet — send a message first, then /ctx.');
    return;
  }
  if (isBusy(sessionManager, runtime.botId, cwd)) {
    await reply(ctx, 'Claude is busy right now — try /ctx again once the current turn finishes.');
    return;
  }
  try {
    const usage = await fetchContextUsage({ sessionId, cwd });
    await reply(ctx, formatContextUsage(usage, sessionId, cwd));
  } catch (err: unknown) {
    await reply(ctx, `❌ Couldn't read context usage: ${escapeHtml(getErrorMessage(err))}`);
  }
}

const CTX_CATEGORY_PAD = 16;
const CTX_RULE_WIDTH = 24;

/** Renders an SDK context-usage breakdown as an HTML message with a per-category token table. */
function formatContextUsage(
  usage: SDKControlGetContextUsageResponse,
  sessionId: string,
  cwd: string,
): string {
  const header = `${Math.round(usage.percentage)}% full   ${fmtTokens(usage.totalTokens)} / ${fmtTokens(usage.maxTokens)}`;
  const rows = usage.categories
    .filter((c) => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((c) => `${c.name.padEnd(CTX_CATEGORY_PAD)} ${fmtTokens(c.tokens).padStart(6)}`);
  const body = rows.length > 0
    ? `${header}\n${'─'.repeat(CTX_RULE_WIDTH)}\n${rows.join('\n')}`
    : header;
  return [
    '📊 <b>Context usage</b>',
    `<pre>${escapeHtml(body)}</pre>`,
    `<code>${escapeHtml(sessionId.slice(0, 8))}</code> · <code>${escapeHtml(prettyPath(cwd))}</code>`,
  ].join('\n');
}

async function handleAbort(ctx: Context, { sessionManager, coordinator, runtime, reply }: CommandDeps): Promise<void> {
  const sessionId = getActiveSessionIdForCwd(sessionManager, runtime.botId, runtime.cwd);
  if (!sessionId) {
    await reply(ctx, 'Nothing to abort.');
    return;
  }
  // Coordinator owns our own runs (clears pending + aborts); fall back to the raw
  // registry for a session held by another client.
  if (!coordinator.abort(sessionId)) {
    sessionManager.abort(sessionId);
  }
  await reply(ctx, '🛑 <b>Aborted.</b>');
}

async function handleNewBot(ctx: Context, { reply }: CommandDeps): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text('✅ Onboard a bot', 'newbot:confirm')
    .text('✖ Cancel', 'cancel');
  await reply(ctx, "Onboard a <b>new Telegram bot</b>? You'll paste its @BotFather token next.", keyboard);
}
