import { config as loadDotenv } from "dotenv";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

loadDotenv();

function readEnv(name: string, fallback = ""): string {
  const value = process.env[name];
  return value == null || value.trim() === "" ? fallback : value.trim();
}

function readIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(readEnv(name), 10);
  return Number.isFinite(value) ? value : fallback;
}

export interface AppConfig {
  telegramBotToken: string;
  telegramProxy?: string;
  codexBin: string;
  codexTextRunner: "exec" | "app-server";
  codexWorkspace: string;
  codexModel?: string;
  codexProfile?: string;
  codexSandbox?: string;
  codexStateDb: string;
  voiceDir: string;
  ffmpegBin: string;
  realtimeVoice?: string;
  realtimeTimeoutMs: number;
  stateFile: string;
  maxTelegramChars: number;
  statusUpdateMs: number;
}

export function loadConfig(): AppConfig {
  const telegramBotToken = readEnv("TELEGRAM_BOT_TOKEN");
  if (!telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and fill it.");
  }

  const stateFile = resolve(readEnv("STATE_FILE", "./data/state.json"));
  const voiceDir = resolve(readEnv("VOICE_DIR", "./data/voice"));
  mkdirSync(resolve(stateFile, ".."), { recursive: true });
  mkdirSync(voiceDir, { recursive: true });

  return {
    telegramBotToken,
    telegramProxy: readEnv("TELEGRAM_PROXY") || undefined,
    codexBin: readEnv("CODEX_BIN", "codex"),
    codexTextRunner: readCodexTextRunner(),
    codexWorkspace: resolve(readEnv("CODEX_WORKSPACE", process.cwd())),
    codexModel: readEnv("CODEX_MODEL") || undefined,
    codexProfile: readEnv("CODEX_PROFILE") || undefined,
    codexSandbox: readEnv("CODEX_SANDBOX", "workspace-write") || undefined,
    codexStateDb: resolve(readEnv("CODEX_STATE_DB", `${readEnv("CODEX_HOME", resolve(homedir(), ".codex"))}/state_5.sqlite`)),
    voiceDir,
    ffmpegBin: readEnv("FFMPEG_BIN", "ffmpeg"),
    realtimeVoice: readEnv("CODEX_REALTIME_VOICE") || undefined,
    realtimeTimeoutMs: readIntEnv("CODEX_REALTIME_TIMEOUT_SECONDS", 120) * 1000,
    stateFile,
    maxTelegramChars: readIntEnv("MAX_TELEGRAM_CHARS", 3800),
    statusUpdateMs: readIntEnv("STATUS_UPDATE_SECONDS", 30) * 1000,
  };
}

function readCodexTextRunner(): "exec" | "app-server" {
  const value = readEnv("CODEX_TEXT_RUNNER", "exec").toLowerCase();
  if (value === "exec" || value === "app-server") {
    return value;
  }
  throw new Error("CODEX_TEXT_RUNNER must be either 'exec' or 'app-server'.");
}
