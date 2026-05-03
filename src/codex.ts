import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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

export function startCodexRun(config: AppConfig, prompt: string, workspace: string, sessionId?: string): CodexRun {
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
      const id = extractSessionIdFromJsonLine(line);
      if (id) {
        discoveredSessionId = id;
      }
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
      const trailingId = extractSessionIdFromJsonLine(stdoutBuffer);
      if (trailingId) {
        discoveredSessionId = trailingId;
      }

      const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8").trim() : "";
      const fallbackSessionId = sessionId ?? discoveredSessionId ?? findLatestCodexSessionId(startedAt, workspace);
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
  const args = ["exec", "resume", "--json", "--output-last-message", outputPath];
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

function extractSessionIdFromJsonLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const event = JSON.parse(trimmed) as unknown;
    return extractSessionId(event, false);
  } catch {
    return undefined;
  }
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

function findLatestCodexSessionId(startedAt: number, workspace: string): string | undefined {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  if (!existsSync(root)) {
    return undefined;
  }

  const candidates = listJsonlFiles(root)
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .filter((item) => item.mtimeMs >= startedAt - 5000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    const meta = readSessionMeta(candidate.path);
    if (meta?.id && (!meta.cwd || meta.cwd === workspace)) {
      return meta.id;
    }
  }
  return candidates.map((candidate) => readSessionMeta(candidate.path)?.id).find(Boolean);
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
  const head = readFileSync(path, "utf8").split(/\r?\n/, 8);
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
