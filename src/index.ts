import { Bot, type Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { findLatestCodexSessionId, startCodexRun, type CodexRun } from "./codex.js";
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
      `topic: ${topic.key}`,
      `codex session: ${session?.codexSessionId ?? "(not created)"}`,
      `workspace: ${getWorkspace(session)}`,
      `busy: ${busy ? "yes" : "no"}`,
      `queued/running: ${queued ? "yes" : "no"}`,
    ].join("\n"),
  );
});

bot.command("session", async (ctx) => {
  const topic = getTopic(ctx);
  const session = store.get(topic.key);
  await replyInTopic(ctx, session?.codexSessionId ? session.codexSessionId : "This topic does not have a Codex session yet.");
});

bot.command("resume", async (ctx) => {
  const topic = getTopic(ctx);
  const existing = store.get(topic.key);
  const workspace = getWorkspace(existing);
  const request = parseResumeRequest(typeof ctx.match === "string" ? ctx.match : "");

  if (!request.last && !request.sessionRef) {
    await replyInTopic(ctx, resumeUsage());
    return;
  }

  const sessionRef = request.last
    ? findLatestCodexSessionId({ workspace, all: request.all })
    : request.sessionRef;

  if (!sessionRef) {
    await replyInTopic(
      ctx,
      request.last
        ? `No previous Codex session found${request.all ? "." : ` for workspace:\n${workspace}`}`
        : "No Codex session id or thread name was provided.",
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
      await replyInTopic(ctx, `Queued resume of Codex session ${shortId(sessionRef)}.`);
    }
    return;
  }

  await replyInTopic(ctx, `This topic now resumes Codex session:\n${sessionRef}\nSend a normal message here to continue it.`);
});

bot.command("cwd", async (ctx) => {
  const topic = getTopic(ctx);
  const session = store.get(topic.key);
  const rawPath = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (!rawPath) {
    await replyInTopic(ctx, `Current workspace:\n${getWorkspace(session)}`);
    return;
  }

  const nextWorkspace = expandPath(rawPath);
  if (!existsSync(nextWorkspace) || !statSync(nextWorkspace).isDirectory()) {
    await replyInTopic(ctx, `Workspace does not exist or is not a directory:\n${nextWorkspace}`);
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

  await replyInTopic(ctx, `Workspace switched for this topic:\n${nextWorkspace}\nThe next normal message will create a fresh Codex session here.`);
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
  await replyInTopic(ctx, "Forgot this topic's Codex session. The next message will create a fresh session in the same workspace.");
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
    await replyInTopic(ctx, "Started a fresh topic mapping. Send a normal message here to create the new Codex session.");
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

console.log(`codex-telegram bridge started; workspace=${config.codexWorkspace}; state=${config.stateFile}`);
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

  const run = startCodexRun(config, prompt, workspace, session.codexSessionId);
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
    await replyLong(ctx, finalText);
  } catch (error) {
    await replyLong(ctx, formatError(error));
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

async function replyLong(ctx: Context, text: string): Promise<void> {
  const chunks = splitText(text, config.maxTelegramChars);
  for (const chunk of chunks) {
    await replyInTopic(ctx, chunk);
  }
}

async function replyInTopic(ctx: Context, text: string): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  await ctx.reply(text, threadId ? { message_thread_id: threadId } : undefined);
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

function helpText(): string {
  return [
    "Codex Telegram bridge",
    "",
    "Normal messages in this Telegram topic continue the same Codex session.",
    "",
    "/status - show this topic mapping and busy state",
    "/session - show this topic's Codex session id",
    "/resume <session-id|thread-name> [prompt] - bind this topic to an existing Codex session",
    "/resume --last [prompt] - bind this topic to the latest Codex session in the current workspace",
    "/cwd [path] - show or switch this topic's Codex workspace",
    "/new [prompt] - start a fresh Codex session in this topic",
    "/reset - forget this topic mapping",
    "/cancel - terminate the active Codex run in this topic",
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

  for (const token of tokens) {
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

function resumeUsage(): string {
  return [
    "Usage:",
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
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return resolve(homedir(), input.slice(2));
  }
  return resolve(input);
}

function shortId(id?: string): string | undefined {
  return id ? id.slice(0, 8) : undefined;
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
