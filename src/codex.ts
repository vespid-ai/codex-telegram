import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CodexRun {
  child: ChildProcessWithoutNullStreams;
  promise: Promise<CodexResult>;
  cancel: () => void;
}

export interface CodexResult {
  sessionId?: string;
  output: string;
  stderr: string;
}

export interface CodexRunOptions {
  onStreamText?: (text: string) => void;
  onStreamEvent?: (text: string) => void;
}

export interface CodexSessionSummary {
  id: string;
  cwd?: string;
  title?: string;
  createdAt?: string;
  updatedAt: Date;
  path: string;
}

export function startCodexRun(
  config: AppConfig,
  prompt: string,
  workspace: string,
  sessionId?: string,
  options: CodexRunOptions = {},
): CodexRun {
  const startedAt = Date.now();
  const tempDir = mkdtempSync(join(tmpdir(), "codex-telegram-"));
  const outputPath = join(tempDir, "last-message.txt");
  const args = sessionId
    ? buildResumeArgs(config, sessionId, outputPath)
    : buildNewSessionArgs(config, workspace, outputPath);

  const child = spawn(config.codexBin, args, {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  let stdoutBuffer = "";
  let stderr = "";
  let discoveredSessionId: string | undefined;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      discoveredSessionId = handleJsonEventLine(line, options) ?? discoveredSessionId;
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.stdin.end(prompt);

  const promise = new Promise<CodexResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const trailingId = handleJsonEventLine(stdoutBuffer, options);
      if (trailingId) {
        discoveredSessionId = trailingId;
      }

      const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8").trim() : "";
      const fallbackSessionId = sessionId ?? discoveredSessionId ?? findLatestCodexSessionId({ startedAt, workspace });
      rmSync(tempDir, { recursive: true, force: true });

      if (code === 0) {
        resolve({ sessionId: fallbackSessionId, output, stderr: stderr.trim() });
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`codex failed with ${reason}${stderr ? `\n${stderr.trim()}` : ""}`));
    });
  });

  return {
    child,
    promise,
    cancel: () => terminateChild(child),
  };
}

function buildNewSessionArgs(config: AppConfig, workspace: string, outputPath: string): string[] {
  const args = ["exec", "--json", "--skip-git-repo-check", "--output-last-message", outputPath, "--cd", workspace];
  if (config.codexModel) args.push("--model", config.codexModel);
  if (config.codexProfile) args.push("--profile", config.codexProfile);
  if (config.codexSandbox) args.push("--sandbox", config.codexSandbox);
  args.push("-");
  return args;
}

function buildResumeArgs(config: AppConfig, sessionId: string, outputPath: string): string[] {
  const args = ["exec", "resume", "--json", "--skip-git-repo-check", "--output-last-message", outputPath];
  if (config.codexModel) args.push("--model", config.codexModel);
  args.push(sessionId, "-");
  return args;
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode != null || child.killed) {
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode == null && !child.killed) {
      child.kill("SIGKILL");
    }
  }, 5000).unref();
}

function handleJsonEventLine(line: string, options: CodexRunOptions): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const event = JSON.parse(trimmed) as unknown;
    const streamEvent = formatStreamEvent(event);
    if (streamEvent) {
      options.onStreamEvent?.(streamEvent);
    }
    const streamText = extractStreamText(event);
    if (streamText) {
      options.onStreamText?.(streamText);
    }
    return extractSessionId(event, false);
  } catch {
    return undefined;
  }
}

function extractStreamText(value: unknown): string | undefined {
  if (value == null || typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    return joinText(value.map(extractStreamText).filter(Boolean));
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  const payload = record.payload && typeof record.payload === "object" ? (record.payload as Record<string, unknown>) : undefined;

  if (type === "item.completed" && record.item && typeof record.item === "object") {
    const item = record.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      return item.text;
    }
    return extractAssistantMessageText(item);
  }

  if (type === "event_msg" && payload?.type === "agent_message" && typeof payload.message === "string") {
    return payload.message;
  }

  if (type === "agent_message" && typeof record.message === "string") {
    return record.message;
  }

  if (type === "response_item" && payload) {
    return extractAssistantMessageText(payload);
  }

  return extractAssistantMessageText(record);
}

function formatStreamEvent(value: unknown): string | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "thread.started") {
    return "Session started";
  }
  if (type === "turn.started") {
    return "Turn started";
  }
  if (type === "turn.completed") {
    return "Turn completed";
  }
  if (type === "item.started") {
    return formatItemEvent("Started", record.item);
  }
  if (type === "item.completed") {
    return formatItemEvent("Completed", record.item);
  }
  return undefined;
}

function formatItemEvent(prefix: string, item: unknown): string | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "agent_message") {
    return `${prefix}: assistant message`;
  }
  if (type === "reasoning") {
    return `${prefix}: reasoning`;
  }
  if (type === "function_call") {
    const name = typeof record.name === "string" ? record.name : "tool call";
    return `${prefix}: ${name}`;
  }
  if (type === "function_call_output") {
    return `${prefix}: tool output`;
  }
  if (type) {
    return `${prefix}: ${type}`;
  }
  return undefined;
}

function extractAssistantMessageText(record: Record<string, unknown>): string | undefined {
  const type = typeof record.type === "string" ? record.type : "";
  const role = typeof record.role === "string" ? record.role : "";

  if (type === "message" && role === "assistant") {
    return extractContentText(record.content);
  }

  const item = record.item;
  if (item && typeof item === "object") {
    return extractAssistantMessageText(item as Record<string, unknown>);
  }

  return undefined;
}

function extractContentText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const texts = content
    .map((part) => {
      if (!part || typeof part !== "object") return undefined;
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.output_text === "string") return record.output_text;
      return undefined;
    })
    .filter(Boolean);

  return joinText(texts);
}

function joinText(parts: Array<string | undefined>): string | undefined {
  const text = parts
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n")
    .trim();
  return text || undefined;
}

function extractSessionId(value: unknown, inSessionContext: boolean): string | undefined {
  if (value == null || typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractSessionId(item, inSessionContext);
      if (found) return found;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const nextSessionContext = inSessionContext || type.includes("session");

  for (const key of ["session_id", "sessionId", "thread_id", "threadId", "conversation_id", "conversationId"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && UUID_RE.test(candidate)) {
      return candidate;
    }
  }

  if (nextSessionContext && typeof record.id === "string" && UUID_RE.test(record.id)) {
    return record.id;
  }

  for (const nested of Object.values(record)) {
    const found = extractSessionId(nested, nextSessionContext);
    if (found) return found;
  }
  return undefined;
}

export function findLatestCodexSessionId(options: { startedAt?: number; workspace?: string; all?: boolean }): string | undefined {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  if (!existsSync(root)) {
    return undefined;
  }

  const candidates = listJsonlFiles(root)
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .filter((item) => options.startedAt == null || item.mtimeMs >= options.startedAt - 5000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    const meta = readSessionMeta(candidate.path);
    if (meta?.id && (options.all || !options.workspace || !meta.cwd || meta.cwd === options.workspace)) {
      return meta.id;
    }
  }
  return candidates.map((candidate) => readSessionMeta(candidate.path)?.id).find(Boolean);
}

export function listCodexSessions(options: { workspace?: string; all?: boolean; limit?: number }): CodexSessionSummary[] {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  if (!existsSync(root)) {
    return [];
  }

  const limit = options.limit ?? 10;
  const sessions: CodexSessionSummary[] = [];
  const candidates = listJsonlFiles(root)
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    const session = readSessionSummary(candidate.path, candidate.mtimeMs);
    if (!session?.id) continue;
    if (!(options.all || !options.workspace || !session.cwd || session.cwd === options.workspace)) continue;
    sessions.push(session);
    if (sessions.length >= limit) {
      break;
    }
  }

  return sessions;
}

export function resolveCodexSessionRef(ref: string, options: { workspace?: string; all?: boolean }): string | undefined {
  if (UUID_RE.test(ref)) {
    return ref;
  }
  if (!/^[0-9a-f]{6,36}$/i.test(ref)) {
    return undefined;
  }

  const matches = listCodexSessions({ ...options, limit: 200 }).filter((session) => session.id.startsWith(ref));
  return matches.length === 1 ? matches[0].id : undefined;
}

function listJsonlFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

function readSessionMeta(path: string): { id?: string; cwd?: string } | undefined {
  const head = readFilePrefix(path).split(/\r?\n/, 8);
  for (const line of head) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type !== "session_meta") continue;
      const payload = parsed.payload as Record<string, unknown> | undefined;
      return {
        id: typeof payload?.id === "string" ? payload.id : undefined,
        cwd: typeof payload?.cwd === "string" ? payload.cwd : undefined,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

function readSessionSummary(path: string, mtimeMs: number): CodexSessionSummary | undefined {
  const lines = readFilePrefix(path).split(/\r?\n/, 200);
  let id: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let title: string | undefined;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === "session_meta") {
        const payload = parsed.payload as Record<string, unknown> | undefined;
        id = typeof payload?.id === "string" ? payload.id : id;
        cwd = typeof payload?.cwd === "string" ? payload.cwd : cwd;
        createdAt = typeof payload?.timestamp === "string" ? payload.timestamp : createdAt;
        continue;
      }
      if (parsed.type === "event_msg") {
        const payload = parsed.payload as Record<string, unknown> | undefined;
        if (payload?.type === "thread_name_updated" && typeof payload.thread_name === "string") {
          title = payload.thread_name;
        }
      }
    } catch {
      continue;
    }
  }

  if (!id) {
    return undefined;
  }
  return { id, cwd, title, createdAt, updatedAt: new Date(mtimeMs), path };
}

function readFilePrefix(path: string, maxBytes = 256 * 1024): string {
  const size = statSync(path).size;
  const buffer = Buffer.alloc(Math.min(size, maxBytes));
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}
