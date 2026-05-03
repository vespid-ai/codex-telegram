import { Bot, type Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import {
  findLatestCodexSessionId,
  listCodexSessions,
  resolveCodexSessionRef,
  startCodexRun,
  type CodexRun,
  type CodexSessionSummary,
} from "./codex.js";
import { StateStore, topicKey, type TopicSession } from "./state.js";

const config = loadConfig();
const store = new StateStore(config.stateFile);
const bot = new Bot(config.telegramBotToken, {
  client: config.telegramProxy
    ? {
        baseFetchConfig: {
          agent: new HttpsProxyAgent(config.telegramProxy),
        },
      }
    : undefined,
});

const queues = new Map<string, Promise<void>>();
const activeRuns = new Map<string, CodexRun>();
const botInfo = await bot.api.getMe();
const botUsername = botInfo.username.toLowerCase();
const STREAM_UPDATE_MS = 1500;
const STREAM_PREVIEW_CHARS = 2600;

bot.command("start", async (ctx) => {
  await replyInTopic(ctx, helpText());
});

bot.command("help", async (ctx) => {
  await replyInTopic(ctx, helpText());
});

bot.command("status", async (ctx) => {
  const topic = getTopic(ctx);
  const session = store.get(topic.key);
  const busy = activeRuns.has(topic.key);
  const queued = queues.has(topic.key);
  await replyInTopic(
    ctx,
    [
      "Status",
      "",
      `Topic: ${topic.key}`,
      `Session: ${session?.codexSessionId ? shortId(session.codexSessionId) : "not created"}`,
      `Workspace: ${compactPath(getWorkspace(session))}`,
      `Busy: ${busy ? "yes" : "no"}`,
      `Queued or running: ${queued ? "yes" : "no"}`,
    ].join("\n"),
  );
});

bot.command("session", async (ctx) => {
  await replySession(ctx);
});

bot.command("resume", async (ctx) => {
  const topic = getTopic(ctx);
  const existing = store.get(topic.key);
  const workspace = getWorkspace(existing);
  const request = parseResumeRequest(typeof ctx.match === "string" ? ctx.match : "");

  if (!request.last && !request.sessionRef) {
    await replyLong(
      ctx,
      formatSessionList(listCodexSessions({ workspace, all: request.all, limit: 10 }), workspace, request.all, existing?.codexSessionId),
      "Codex sessions",
    );
    return;
  }

  const sessionRef = request.last
    ? findLatestCodexSessionId({ workspace, all: request.all })
    : resolveResumeRef(request.sessionRef, workspace, request.all);

  if (!sessionRef) {
    await replyInTopic(
      ctx,
      request.last
        ? `No previous Codex session found${request.all ? "." : ` for workspace:\n${workspace}`}`
        : `No matching Codex session found for:\n${request.sessionRef}`,
    );
    return;
  }

  store.upsert({
    key: topic.key,
    chatId: topic.chatId,
    threadId: topic.threadId,
    title: topic.title ?? existing?.title,
    workspace,
    codexSessionId: sessionRef,
  });

  if (request.prompt) {
    const queued = schedule(topic.key, () => runPrompt(ctx, request.prompt, false));
    if (queued) {
      await replyInTopic(ctx, `Queued resume: ${shortId(sessionRef)}.`);
    }
    return;
  }

  await replyInTopic(ctx, `Resumed session ${shortId(sessionRef)}.\nSend a normal message here to continue it.`);
});

bot.command("cwd", async (ctx) => {
  const topic = getTopic(ctx);
  const session = store.get(topic.key);
  const rawPath = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (!rawPath) {
    await replyInTopic(ctx, `Current workspace:\n${compactPath(getWorkspace(session))}`);
    return;
  }

  const nextWorkspace = expandPath(rawPath);
  if (!existsSync(nextWorkspace) || !statSync(nextWorkspace).isDirectory()) {
    await replyInTopic(ctx, formatWorkspaceNotFound(nextWorkspace));
    return;
  }

  store.upsert({
    key: topic.key,
    chatId: topic.chatId,
    threadId: topic.threadId,
    title: topic.title ?? session?.title,
    codexSessionId: undefined,
    workspace: nextWorkspace,
  });

  await replyInTopic(ctx, `Workspace switched:\n${compactPath(nextWorkspace)}\nThe next normal message will create a fresh Codex session here.`);
});

bot.command("reset", async (ctx) => {
  const topic = getTopic(ctx);
  const session = store.get(topic.key);
  if (!session) {
    await replyInTopic(ctx, "No mapping existed for this topic.");
    return;
  }
  store.upsert({
    key: topic.key,
    chatId: topic.chatId,
    threadId: topic.threadId,
    title: session.title,
    codexSessionId: undefined,
    workspace: session.workspace,
  });
  await replyInTopic(ctx, "Forgot this topic's Codex session.\nThe next message will create a fresh session in the same workspace.");
});

bot.command("new", async (ctx) => {
  const topic = getTopic(ctx);
  store.forget(topic.key);
  const prompt = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (!prompt) {
    store.upsert({
      key: topic.key,
      chatId: topic.chatId,
      threadId: topic.threadId,
      title: topic.title,
      workspace: existingWorkspace(topic.key),
    });
    await replyInTopic(ctx, "Started a fresh topic mapping.\nSend a normal message here to create the new Codex session.");
    return;
  }
  schedule(topic.key, () => runPrompt(ctx, prompt, true));
});

bot.command("cancel", async (ctx) => {
  const topic = getTopic(ctx);
  const run = activeRuns.get(topic.key);
  if (!run) {
    await replyInTopic(ctx, "No Codex run is active in this topic.");
    return;
  }
  run.cancel();
  await replyInTopic(ctx, "Cancellation requested for the active Codex run in this topic.");
});

bot.on("message:forum_topic_created", async (ctx) => {
  const topic = getTopic(ctx);
  store.upsert({
    key: topic.key,
    chatId: topic.chatId,
    threadId: topic.threadId,
    title: topic.title,
    workspace: existingWorkspace(topic.key),
  });
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text || text.startsWith("/")) {
    if (text.startsWith("/")) {
      const handled = await handleCommandFallback(ctx, text);
      if (!handled) {
        await replyInTopic(ctx, `Unknown command: ${text.split(/\s+/, 1)[0]}\nSend /help to see available commands.`);
      }
    }
    return;
  }
  const topic = getTopic(ctx);
  const queued = schedule(topic.key, () => runPrompt(ctx, text, false));
  if (queued) {
    await replyInTopic(ctx, "Queued behind the active Codex run in this topic.");
  }
});

bot.catch(async (err) => {
  console.error("bot error", err);
});

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await bot.api.setMyCommands([
  { command: "help", description: "Show Codex Telegram bridge usage" },
  { command: "status", description: "Show current topic status" },
  { command: "session", description: "Show current Codex session id" },
  { command: "resume", description: "Bind this topic to an existing Codex session" },
  { command: "cwd", description: "Show or switch this topic's Codex workspace" },
  { command: "new", description: "Start a fresh Codex session in this topic" },
  { command: "reset", description: "Forget this topic mapping" },
  { command: "cancel", description: "Cancel the active Codex run in this topic" },
]);

console.log(`codex-telegram bridge started; bot=@${botUsername}; workspace=${config.codexWorkspace}; state=${config.stateFile}`);
await bot.start();

async function runPrompt(ctx: Context, prompt: string, forceFresh: boolean): Promise<void> {
  const topic = getTopic(ctx);
  const existing = forceFresh ? undefined : store.get(topic.key);
  const workspace = getWorkspace(existing);
  const session = store.upsert({
    key: topic.key,
    chatId: topic.chatId,
    threadId: topic.threadId,
    title: topic.title ?? existing?.title,
    workspace,
    codexSessionId: existing?.codexSessionId,
    lastPrompt: prompt,
  });

  const statusMessage = session.codexSessionId
    ? `Resuming Codex session ${shortId(session.codexSessionId)}...`
    : "Creating a new Codex session for this topic...";
  await replyInTopic(ctx, statusMessage);

  const streamPreview = createTelegramStreamPreview(ctx);
  await streamPreview.start(session.codexSessionId ? `Resuming ${shortId(session.codexSessionId)}...` : "Starting new Codex session...");
  const run = startCodexRun(config, prompt, workspace, session.codexSessionId, {
    onStreamText: streamPreview.push,
    onStreamEvent: streamPreview.event,
  });
  activeRuns.set(topic.key, run);

  const heartbeat = setInterval(() => {
    void replyInTopic(ctx, `Codex is still working in this topic (${shortId(store.get(topic.key)?.codexSessionId) ?? "new session"}).`);
  }, config.statusUpdateMs);
  heartbeat.unref();

  try {
    const result = await run.promise;
    if (result.sessionId && result.sessionId !== session.codexSessionId) {
      if (store.get(topic.key)) {
        store.setSessionId(topic.key, result.sessionId);
      } else {
        store.upsert({
          key: topic.key,
          chatId: topic.chatId,
          threadId: topic.threadId,
          title: topic.title,
          workspace,
          codexSessionId: result.sessionId,
          lastPrompt: prompt,
        });
      }
    }

    const finalText = result.output || result.stderr || "Codex completed without a final message.";
    await streamPreview.finish("Codex finished. Final result below.");
    await replyLong(ctx, finalText, "Codex result");
  } catch (error) {
    await streamPreview.finish("Codex stopped. Error below.");
    await replyLong(ctx, formatError(error), "Codex error");
  } finally {
    clearInterval(heartbeat);
    activeRuns.delete(topic.key);
  }
}

function schedule(key: string, task: () => Promise<void>): boolean {
  const wasQueued = queues.has(key);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (queues.get(key) === next) {
        queues.delete(key);
      }
    });
  queues.set(key, next);
  next.catch((error) => {
    console.error(`queued task failed for ${key}`, error);
  });
  return wasQueued;
}

function getTopic(ctx: Context): TopicSession {
  const chatId = ctx.chat?.id;
  if (chatId == null) {
    throw new Error("Message has no chat id.");
  }

  const message = ctx.message;
  const threadId = message?.message_thread_id ?? 0;
  const title = message?.forum_topic_created?.name;
  return {
    key: topicKey(chatId, threadId),
    chatId,
    threadId,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function replySession(ctx: Context): Promise<void> {
  const topic = getTopic(ctx);
  const session = store.get(topic.key);
  await replyInTopic(ctx, session?.codexSessionId ? session.codexSessionId : "This topic does not have a Codex session yet.");
}

async function handleCommandFallback(ctx: Context, text: string): Promise<boolean> {
  const command = parseFallbackCommand(text);
  if (!command) {
    return false;
  }

  switch (command) {
    case "session":
      await replySession(ctx);
      return true;
    case "help":
    case "start":
      await replyInTopic(ctx, helpText());
      return true;
    default:
      return false;
  }
}

function parseFallbackCommand(text: string): string | undefined {
  const token = text.split(/\s+/, 1)[0];
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/.exec(token);
  if (!match) {
    return undefined;
  }

  const target = match[2]?.toLowerCase();
  if (target && target !== botUsername) {
    return undefined;
  }
  return match[1].toLowerCase();
}

async function replyLong(ctx: Context, text: string, label = "Message"): Promise<void> {
  const readableText = formatMarkdownForTelegram(text);
  const chunks = splitText(readableText, config.maxTelegramChars);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const header = chunks.length > 1 ? `${label} ${index + 1}/${chunks.length}\n\n` : "";
    await replyInTopic(ctx, `${header}${chunk}`);
  }
}

async function replyInTopic(ctx: Context, text: string) {
  const threadId = ctx.message?.message_thread_id;
  try {
    return await ctx.reply(text, threadId ? { message_thread_id: threadId } : undefined);
  } catch (error) {
    console.error("failed to send Telegram message; retrying once", error);
    await delay(1000);
    try {
      return await ctx.reply(text, threadId ? { message_thread_id: threadId } : undefined);
    } catch (retryError) {
      console.error("failed to send Telegram message after retry", retryError);
      return undefined;
    }
  }
}

function createTelegramStreamPreview(ctx: Context): {
  start: (status: string) => Promise<void>;
  event: (text: string) => void;
  push: (text: string) => void;
  finish: (status: string) => Promise<void>;
} {
  const chatId = ctx.chat?.id;
  let buffer = "";
  const events: string[] = [];
  let messageId: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSent = "";
  let pending = Promise.resolve();

  const flush = async (status: string): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const text = buildStreamPreview(buffer, events, status);
    if (!text || text === lastSent || chatId == null) {
      return pending;
    }

    pending = pending
      .catch(() => undefined)
      .then(async () => {
        try {
          if (messageId) {
            await ctx.api.editMessageText(chatId, messageId, text);
          } else {
            const sent = await replyInTopic(ctx, text);
            messageId = sent?.message_id;
          }
          lastSent = text;
        } catch (error) {
          console.error("failed to update stream preview", error);
        }
      });
    return pending;
  };

  return {
    async start(status: string): Promise<void> {
      events.push(`${formatTime(new Date())} ${status}`);
      await flush("Codex is running...");
    },
    event(text: string): void {
      events.push(`${formatTime(new Date())} ${text}`);
      while (events.length > 8) {
        events.shift();
      }
      void flushSoon("Codex is running...");
    },
    push(text: string): void {
      if (!text.trim()) {
        return;
      }
      buffer = mergeStreamText(buffer, text);
      void flushSoon("Codex is writing...");
    },
    async finish(status: string): Promise<void> {
      await flush(status);
    },
  };

  function flushSoon(status: string): void {
    if (!timer) {
      timer = setTimeout(() => {
        void flush(status);
      }, STREAM_UPDATE_MS);
      timer.unref();
    }
  }
}

function mergeStreamText(current: string, next: string): string {
  const cleanNext = next.trim();
  if (!current) {
    return cleanNext;
  }
  if (cleanNext.startsWith(current)) {
    return cleanNext;
  }
  if (current.includes(cleanNext)) {
    return current;
  }
  return `${current}\n\n${cleanNext}`;
}

function buildStreamPreview(text: string, events: string[], status: string): string | undefined {
  const readable = formatMarkdownForTelegram(text).trim();
  if (!readable && events.length === 0) {
    return undefined;
  }
  const preview =
    readable.length > STREAM_PREVIEW_CHARS
      ? `...${readable.slice(readable.length - STREAM_PREVIEW_CHARS).trimStart()}`
      : readable;
  const parts = [status];
  if (events.length > 0) {
    parts.push(["Events", ...events.map((event) => `- ${event}`)].join("\n"));
  }
  if (preview) {
    parts.push(["Preview", preview].join("\n"));
  }
  return parts.join("\n\n");
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const slice = rest.slice(0, maxChars);
    const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const end = breakAt > maxChars * 0.6 ? breakAt : maxChars;
    chunks.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks;
}

function formatMarkdownForTelegram(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      if (output.length > 0 && output[output.length - 1] !== "") {
        output.push("");
      }
      continue;
    }

    if (inCodeBlock) {
      output.push(line.replace(/\s+$/g, ""));
      continue;
    }

    output.push(formatMarkdownLineForTelegram(line));
  }

  return output
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function formatMarkdownLineForTelegram(line: string): string {
  let next = line.replace(/\s+$/g, "");

  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(next)) {
    return "";
  }

  next = next.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/, "$1");
  next = next.replace(/^(\s*)[-*+]\s+\[( |x|X)\]\s+/g, "$1- [$2] ");
  next = next.replace(/^(\s*)[-*+]\s+/g, "$1- ");
  next = next.replace(/^(\s*)>\s?/g, "$1> ");
  next = next.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt: string, url: string) =>
    alt ? `${alt}: ${url}` : url,
  );
  next = next.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label: string, url: string) =>
    label === url ? url : `${label}: ${url}`,
  );
  next = next.replace(/`([^`\n]+)`/g, "$1");
  next = next.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  next = next.replace(/__([^_\n]+)__/g, "$1");
  next = next.replace(/~~([^~\n]+)~~/g, "$1");
  next = next.replace(/(^|[\s([{])\*([^*\n]+)\*(?=[\s)\]},.!?:;]|$)/g, "$1$2");
  next = next.replace(/(^|[\s([{])_([^_\n]+)_(?=[\s)\]},.!?:;]|$)/g, "$1$2");

  if (/^\s*\|.+\|\s*$/.test(next)) {
    next = next
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim())
      .join(" | ");
  }

  if (/^\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+$/.test(next)) {
    return "";
  }

  return next;
}

function helpText(): string {
  return [
    "Codex Telegram bridge",
    "",
    "Normal messages in this Telegram topic continue the same Codex session.",
    "",
    "Commands",
    "/status - current topic state",
    "/session - current Codex session id",
    "/resume - show recent sessions",
    "/resume <short-id|session-id> [prompt] - bind this topic to a session",
    "/resume --all - show recent sessions from all workspaces",
    "/resume --last [prompt] - resume the latest session in this workspace",
    "/cwd [path] - show or switch workspace",
    "/new [prompt] - start a fresh session",
    "/reset - forget this topic mapping",
    "/cancel - cancel the active Codex run",
  ].join("\n");
}

interface ResumeRequest {
  sessionRef?: string;
  last: boolean;
  all: boolean;
  prompt: string;
}

function parseResumeRequest(input: string): ResumeRequest {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  let last = false;
  let all = false;
  let sessionRef: string | undefined;
  const promptTokens: string[] = [];

  for (const rawToken of tokens) {
    const token = normalizeResumeOption(rawToken);
    if (!sessionRef && token === "--last") {
      last = true;
      continue;
    }
    if (!sessionRef && token === "--all") {
      all = true;
      continue;
    }
    if (!last && !sessionRef) {
      sessionRef = token;
      continue;
    }
    promptTokens.push(token);
  }

  return { sessionRef, last, all, prompt: promptTokens.join(" ") };
}

function normalizeResumeOption(token: string): string {
  if (token.startsWith("—")) {
    return `--${token.slice(1)}`;
  }
  if (token.startsWith("–")) {
    return `--${token.slice(1)}`;
  }
  return token;
}

function resumeUsage(): string {
  return [
    "Usage:",
    "/resume",
    "/resume --all",
    "/resume <session-id|thread-name> [prompt]",
    "/resume --last [prompt]",
    "/resume --last --all [prompt]",
  ].join("\n");
}

function getWorkspace(session?: TopicSession): string {
  return session?.workspace ?? config.codexWorkspace;
}

function existingWorkspace(key: string): string {
  return getWorkspace(store.get(key));
}

function expandPath(input: string): string {
  const path = stripPathQuotes(input.trim());
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

function stripPathQuotes(input: string): string {
  const quotePairs: Record<string, string> = {
    "'": "'",
    '"': '"',
    "`": "`",
    "‘": "’",
    "“": "”",
  };
  const first = input[0];
  const last = input[input.length - 1];
  return first && quotePairs[first] === last ? input.slice(1, -1).trim() : input;
}

function formatWorkspaceNotFound(path: string): string {
  const lines = ["Workspace does not exist or is not a directory:", compactPath(path)];
  const suggestions = findWorkspaceSuggestions(path);
  if (suggestions.length > 0) {
    lines.push("", "Similar directories:");
    for (const suggestion of suggestions) {
      lines.push(compactPath(suggestion));
    }
  }
  return lines.join("\n");
}

function findWorkspaceSuggestions(path: string): string[] {
  const parent = dirname(path);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    return [];
  }

  const wanted = normalizeWorkspaceName(basename(path));
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name))
    .filter((candidate) => {
      const candidateName = normalizeWorkspaceName(basename(candidate));
      return candidateName.includes(wanted) || wanted.includes(candidateName);
    })
    .slice(0, 3);
}

function normalizeWorkspaceName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "");
}

function resolveResumeRef(sessionRef: string | undefined, workspace: string, all: boolean): string | undefined {
  if (!sessionRef) {
    return undefined;
  }
  const resolved = resolveCodexSessionRef(sessionRef, { workspace, all });
  if (resolved) {
    return resolved;
  }
  return /^[0-9a-f]{6,36}$/i.test(sessionRef) ? undefined : sessionRef;
}

function shortId(id?: string): string | undefined {
  return id ? id.slice(0, 8) : undefined;
}

function formatSessionList(sessions: CodexSessionSummary[], workspace: string, all: boolean, currentSessionId?: string): string {
  if (sessions.length === 0) {
    return [
      "No Codex sessions found.",
      "",
      all ? "Scope: all workspaces" : `Scope: ${compactPath(workspace)}`,
      "",
      resumeUsage(),
    ].join("\n");
  }

  const lines = [
    "Recent Codex sessions",
    "",
    all ? "Scope: all workspaces" : `Scope: ${compactPath(workspace)}`,
    currentSessionId ? `Current topic: ${uniqueSessionRef(currentSessionId, sessions)}` : "Current topic: not bound",
    "Use: /resume <id>",
    "",
  ];

  sessions.forEach((session, index) => {
    const title = session.title ? truncateLine(session.title, 56) : "Untitled session";
    const ref = uniqueSessionRef(session.id, sessions);
    const marker = session.id === currentSessionId ? " current" : "";
    lines.push(`${index + 1}. ${formatDate(session.updatedAt)}  ${ref}${marker}`);
    lines.push(`   ${title}`);
    lines.push(`   ${compactPath(session.cwd ?? "(unknown workspace)")}`);
    lines.push(`   /resume ${ref}`);
    if (index !== sessions.length - 1) {
      lines.push("");
    }
  });

  return lines.join("\n");
}

function uniqueSessionRef(id: string, sessions: CodexSessionSummary[]): string {
  for (const length of [8, 13, 18, 23, 36]) {
    const ref = id.slice(0, length);
    const matches = sessions.filter((session) => session.id.startsWith(ref));
    if (matches.length <= 1) {
      return ref;
    }
  }
  return id;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function compactPath(path: string): string {
  const home = homedir();
  if (path === home) {
    return "~";
  }
  if (path.startsWith(`${home}/`)) {
    return `~/${path.slice(home.length + 1)}`;
  }
  return path;
}

function truncateLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}...` : normalized;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `Codex run failed:\n${error.message}`;
  }
  return `Codex run failed:\n${String(error)}`;
}

function shutdown(): void {
  for (const run of activeRuns.values()) {
    run.cancel();
  }
  void bot.stop();
}
