import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AppConfig } from "./config.js";
import { extractGeneratedImages, type CodexResult, type CodexRun, type GeneratedImage, type StreamTextMode } from "./codex.js";
import { type RealtimeAudioFrame, silenceAudioFrame } from "./voice.js";

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface AppServerRealtimeOptions {
  workspace: string;
  sessionId?: string;
  audio: RealtimeAudioFrame;
  onStreamText?: (text: string, mode?: StreamTextMode) => void;
  onStreamEvent?: (text: string) => void;
}

export interface AppServerTextOptions {
  workspace: string;
  sessionId?: string;
  prompt: string;
  onStreamText?: (text: string, mode?: StreamTextMode) => void;
  onStreamEvent?: (text: string) => void;
}

export function startAppServerTextRun(config: AppConfig, options: AppServerTextOptions): CodexRun {
  const client = new AppServerClient(config);
  const promise = runTextTurn(config, client, options);

  return {
    child: client.child,
    promise,
    cancel: () => client.close(),
  };
}

export function startAppServerRealtimeRun(config: AppConfig, options: AppServerRealtimeOptions): CodexRun {
  const client = new AppServerClient(config);
  const promise = runRealtimeVoice(config, client, options);

  return {
    child: client.child,
    promise,
    cancel: () => client.close(),
  };
}

async function runTextTurn(config: AppConfig, client: AppServerClient, options: AppServerTextOptions): Promise<CodexResult> {
  const state = createRunState(options.sessionId);

  client.onStderr((chunk) => {
    state.stderr += chunk;
  });
  client.onNotification((message) => handleNotification(message, state, options));

  try {
    await initializeClient(client);

    state.threadId = await ensureThread(client, config, options);
    options.onStreamEvent?.(options.sessionId ? "App-server session resumed" : "App-server session started");

    const result = await client.request("turn/start", {
      threadId: state.threadId,
      input: [{ type: "text", text: options.prompt, text_elements: [] }],
      cwd: options.workspace,
      model: config.codexModel ?? null,
    });
    const turn = asRecord(asRecord(result)?.turn);
    if (typeof turn?.id === "string") {
      state.turnId = turn.id;
    }
    state.turnStarted = true;

    await waitForTurnResult(state, config.realtimeTimeoutMs);

    return {
      sessionId: state.threadId,
      output: buildAgentOutput(state),
      stderr: state.stderr.trim(),
      generatedImages: [...state.generatedImages.values()],
    };
  } finally {
    client.close();
  }
}

async function runRealtimeVoice(
  config: AppConfig,
  client: AppServerClient,
  options: AppServerRealtimeOptions,
): Promise<CodexResult> {
  const state = createRunState(options.sessionId);

  client.onStderr((chunk) => {
    state.stderr += chunk;
  });
  client.onNotification((message) => handleNotification(message, state, options));

  try {
    await initializeClient(client);

    state.threadId = await ensureThread(client, config, options);
    options.onStreamEvent?.(options.sessionId ? "App-server session resumed" : "App-server session started");

    await client.request("thread/realtime/start", {
      threadId: state.threadId,
      outputModality: "text",
      prompt: "You are receiving a Telegram voice message. Transcribe it accurately and, if it asks Codex to do work, delegate it to the background agent.",
      sessionId: null,
      transport: null,
      voice: config.realtimeVoice ?? null,
    });

    await waitUntil(() => state.realtimeStarted || state.realtimeClosed, config.realtimeTimeoutMs, "Timed out waiting for Codex realtime to start.");
    if (state.realtimeClosed) {
      throw new Error("Codex realtime closed before audio could be sent.");
    }

    await client.request("thread/realtime/appendAudio", {
      threadId: state.threadId,
      audio: frameForProtocol(options.audio),
    });
    await client.request("thread/realtime/appendAudio", {
      threadId: state.threadId,
      audio: frameForProtocol(silenceAudioFrame(900, `${options.audio.itemId}-silence`)),
    });

    await waitForRealtimeResult(state, config.realtimeTimeoutMs);
    if (!state.realtimeClosed) {
      await client.request("thread/realtime/stop", { threadId: state.threadId }).catch(() => undefined);
    }

    const output = buildRealtimeOutput(state);
    return {
      sessionId: state.threadId,
      output,
      stderr: state.stderr.trim(),
      generatedImages: [...state.generatedImages.values()],
    };
  } finally {
    client.close();
  }
}

async function ensureThread(client: AppServerClient, config: AppConfig, options: Pick<AppServerRealtimeOptions, "workspace" | "sessionId">): Promise<string> {
  const params = {
    threadId: options.sessionId,
    model: config.codexModel ?? null,
    cwd: options.workspace,
    sandbox: normalizeSandbox(config.codexSandbox),
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  };

  if (options.sessionId) {
    const result = await client.request("thread/resume", params);
    return extractThreadId(result);
  }

  const result = await client.request("thread/start", {
    model: config.codexModel ?? null,
    cwd: options.workspace,
    sandbox: normalizeSandbox(config.codexSandbox),
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  });
  return extractThreadId(result);
}

async function initializeClient(client: AppServerClient): Promise<void> {
  await client.start();
  await client.request("initialize", {
    clientInfo: {
      name: "codex_telegram",
      title: "Codex Telegram Bridge",
      version: "1.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
}

function normalizeSandbox(sandbox: string | undefined): string | null {
  if (sandbox === "read-only" || sandbox === "workspace-write" || sandbox === "danger-full-access") {
    return sandbox;
  }
  return null;
}

function extractThreadId(result: unknown): string {
  const record = asRecord(result);
  const thread = asRecord(record?.thread);
  const id = thread?.id;
  if (typeof id !== "string" || !id) {
    throw new Error("Codex app-server response did not include a thread id.");
  }
  return id;
}

interface AppServerRunState {
  threadId?: string;
  turnId?: string;
  stderr: string;
  userTranscripts: string[];
  assistantTranscripts: string[];
  agentMessages: string[];
  agentMessageById: Map<string, string>;
  agentMessageOrder: string[];
  generatedImages: Map<string, GeneratedImage>;
  turnStarted: boolean;
  turnCompleted: boolean;
  realtimeStarted: boolean;
  realtimeClosed: boolean;
  lastMeaningfulEventAt: number;
}

function createRunState(threadId?: string): AppServerRunState {
  return {
    threadId,
    stderr: "",
    userTranscripts: [],
    assistantTranscripts: [],
    agentMessages: [],
    agentMessageById: new Map<string, string>(),
    agentMessageOrder: [],
    generatedImages: new Map<string, GeneratedImage>(),
    turnStarted: false,
    turnCompleted: false,
    realtimeStarted: false,
    realtimeClosed: false,
    lastMeaningfulEventAt: Date.now(),
  };
}

function handleNotification(message: unknown, state: AppServerRunState, options: Pick<AppServerTextOptions, "onStreamText" | "onStreamEvent">): void {
  for (const image of extractGeneratedImages(message)) {
    state.generatedImages.set(image.path, image);
  }

  const record = asRecord(message);
  const method = typeof record?.method === "string" ? record.method : "";
  const params = asRecord(record?.params);

  switch (method) {
    case "thread/realtime/started":
      state.realtimeStarted = true;
      options.onStreamEvent?.("Realtime started");
      touch(state);
      return;
    case "thread/realtime/transcript/delta": {
      const delta = typeof params?.delta === "string" ? params.delta : "";
      const role = typeof params?.role === "string" ? params.role : "";
      if (delta && role === "assistant") {
        options.onStreamText?.(delta, "delta");
      }
      if (delta) touch(state);
      return;
    }
    case "thread/realtime/transcript/done": {
      const text = typeof params?.text === "string" ? params.text.trim() : "";
      const role = typeof params?.role === "string" ? params.role : "";
      if (text && role === "user") {
        state.userTranscripts.push(text);
      } else if (text && role === "assistant") {
        state.assistantTranscripts.push(text);
        options.onStreamText?.(text, "snapshot");
      }
      if (text) touch(state);
      return;
    }
    case "thread/realtime/itemAdded": {
      options.onStreamEvent?.(formatRealtimeItem(params?.item));
      touch(state);
      return;
    }
    case "thread/realtime/error": {
      const error = typeof params?.message === "string" ? params.message : "Realtime error";
      state.stderr += `${state.stderr ? "\n" : ""}${error}`;
      options.onStreamEvent?.(`Realtime error: ${error}`);
      state.realtimeClosed = true;
      touch(state);
      return;
    }
    case "thread/realtime/closed":
      state.realtimeClosed = true;
      options.onStreamEvent?.("Realtime closed");
      touch(state);
      return;
    case "turn/started":
      state.turnStarted = true;
      if (typeof params?.turnId === "string") {
        state.turnId = params.turnId;
      } else {
        const turn = asRecord(params?.turn);
        if (typeof turn?.id === "string") state.turnId = turn.id;
      }
      options.onStreamEvent?.("Turn started");
      touch(state);
      return;
    case "turn/completed":
      state.turnCompleted = true;
      options.onStreamEvent?.("Turn completed");
      touch(state);
      return;
    case "item/agentMessage/delta": {
      const delta = typeof params?.delta === "string" ? params.delta : "";
      const itemId = typeof params?.itemId === "string" ? params.itemId : undefined;
      if (delta) {
        appendAgentText(state, delta, itemId);
        options.onStreamText?.(delta, "delta");
        touch(state);
      }
      return;
    }
    case "item/completed": {
      const item = asRecord(params?.item);
      if (item?.type !== "agentMessage") {
        return;
      }
      const text = extractAgentText(item);
      const itemId = typeof item?.id === "string" ? item.id : undefined;
      if (text) {
        const alreadyStreamed = itemId ? state.agentMessageById.has(itemId) : false;
        appendAgentText(state, text, itemId, true);
        if (!alreadyStreamed) {
          options.onStreamText?.(text, "snapshot");
        }
        touch(state);
      }
      return;
    }
    case "error": {
      const messageText = typeof params?.message === "string" ? params.message : "Codex app-server error";
      state.stderr += `${state.stderr ? "\n" : ""}${messageText}`;
      options.onStreamEvent?.(`Error: ${messageText}`);
      touch(state);
      return;
    }
  }
}

function appendAgentText(state: AppServerRunState, text: string, itemId?: string, replace = false): void {
  if (itemId) {
    if (!state.agentMessageById.has(itemId)) {
      state.agentMessageOrder.push(itemId);
    }
    const current = state.agentMessageById.get(itemId) ?? "";
    state.agentMessageById.set(itemId, replace ? text : `${current}${text}`);
    return;
  }

  const trimmed = text.trim();
  if (!trimmed) return;
  const last = state.agentMessages[state.agentMessages.length - 1];
  if (last && (trimmed.startsWith(last) || last.includes(trimmed))) {
    state.agentMessages[state.agentMessages.length - 1] = trimmed.startsWith(last) ? trimmed : last;
    return;
  }
  state.agentMessages.push(trimmed);
}

async function waitForTurnResult(state: AppServerRunState, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (state.turnStarted && state.turnCompleted) return;
    await delay(250);
  }
  throw new Error("Timed out waiting for Codex app-server text result.");
}

async function waitForRealtimeResult(state: AppServerRunState, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (state.turnStarted && state.turnCompleted) return;
    if (state.realtimeClosed) return;
    const hasRealtimeOutput = state.agentMessages.length > 0 || state.assistantTranscripts.length > 0;
    if (!state.turnStarted && hasRealtimeOutput && Date.now() - state.lastMeaningfulEventAt > 2500) return;
    if (!state.turnStarted && state.userTranscripts.length > 0 && Date.now() - state.lastMeaningfulEventAt > 8000) return;
    await delay(250);
  }
  throw new Error("Timed out waiting for Codex realtime voice result.");
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(100);
  }
  throw new Error(message);
}

function buildRealtimeOutput(state: AppServerRunState): string {
  const parts: string[] = [];
  if (state.userTranscripts.length > 0) {
    parts.push(["Voice transcript", ...state.userTranscripts].join("\n"));
  }
  const agentOutput = buildAgentOutput(state);
  if (agentOutput) {
    parts.push(agentOutput);
  } else if (state.assistantTranscripts.length > 0) {
    parts.push(state.assistantTranscripts.join("\n\n"));
  }
  return parts.join("\n\n").trim();
}

function buildAgentOutput(state: AppServerRunState): string {
  const orderedMessages = state.agentMessageOrder
    .map((id) => state.agentMessageById.get(id)?.trim())
    .filter((text): text is string => Boolean(text));
  return [...state.agentMessages, ...orderedMessages].join("\n\n").trim();
}

function formatRealtimeItem(value: unknown): string {
  const item = asRecord(value);
  const type = typeof item?.type === "string" ? item.type : "realtime item";
  if (type === "handoff_request") return "Realtime delegated to Codex";
  return `Realtime: ${type}`;
}

function extractAgentText(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.text === "string") return record.text;
  const content = record.content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        const part = asRecord(item);
        return typeof part?.text === "string" ? part.text : undefined;
      })
      .filter((item): item is string => Boolean(item?.trim()))
      .join("\n\n")
      .trim();
    return text || undefined;
  }
  return undefined;
}

function frameForProtocol(frame: RealtimeAudioFrame): Record<string, unknown> {
  return {
    data: frame.data,
    sampleRate: frame.sampleRate,
    numChannels: frame.numChannels,
    samplesPerChannel: frame.samplesPerChannel,
    itemId: frame.itemId,
  };
}

function touch(state: AppServerRunState): void {
  state.lastMeaningfulEventAt = Date.now();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

class AppServerClient {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<(message: unknown) => void>();
  private readonly stderrHandlers = new Set<(chunk: string) => void>();
  private started = false;

  constructor(private readonly config: AppConfig) {
    this.child = spawn(config.codexBin, ["app-server", "--enable", "realtime_conversation", "--listen", "stdio://"], {
      cwd: config.codexWorkspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      for (const handler of this.stderrHandlers) handler(chunk);
    });
    this.child.once("close", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      const error = new Error(`codex app-server closed with ${reason}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
    });
    this.child.once("error", (error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Timed out waiting for app-server response to ${method}.`));
      }, Math.min(this.config.realtimeTimeoutMs, 30_000));
      timeout.unref();
      this.pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest, timeout });
      this.child.stdin.write(`${payload}\n`, (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(id);
          rejectRequest(error);
        }
      });
    });
  }

  onNotification(handler: (message: unknown) => void): void {
    this.notificationHandlers.add(handler);
  }

  onStderr(handler: (chunk: string) => void): void {
    this.stderrHandlers.add(handler);
  }

  close(): void {
    if (this.child.exitCode != null || this.child.killed) return;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (this.child.exitCode == null && !this.child.killed) {
        this.child.kill("SIGKILL");
      }
    }, 5000).unref();
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    const record = asRecord(message);
    const id = typeof record?.id === "number" ? record.id : undefined;
    if (id != null && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      const error = asRecord(record?.error);
      if (error) {
        const text = typeof error.message === "string" ? error.message : `app-server request failed: ${pending.method}`;
        pending.reject(new Error(text));
      } else {
        pending.resolve(record?.result);
      }
      return;
    }

    for (const handler of this.notificationHandlers) {
      handler(message);
    }
  }
}
