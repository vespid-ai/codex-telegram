import { config as loadDotenv } from "dotenv";
import { mkdirSync } from "node:fs";
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
  codexWorkspace: string;
  codexModel?: string;
  codexProfile?: string;
  codexSandbox?: string;
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
  mkdirSync(resolve(stateFile, ".."), { recursive: true });

  return {
    telegramBotToken,
    telegramProxy: readEnv("TELEGRAM_PROXY") || undefined,
    codexBin: readEnv("CODEX_BIN", "codex"),
    codexWorkspace: resolve(readEnv("CODEX_WORKSPACE", process.cwd())),
    codexModel: readEnv("CODEX_MODEL") || undefined,
    codexProfile: readEnv("CODEX_PROFILE") || undefined,
    codexSandbox: readEnv("CODEX_SANDBOX", "workspace-write") || undefined,
    stateFile,
    maxTelegramChars: readIntEnv("MAX_TELEGRAM_CHARS", 3800),
    statusUpdateMs: readIntEnv("STATUS_UPDATE_SECONDS", 30) * 1000,
  };
}
