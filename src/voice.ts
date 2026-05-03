import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Context } from "grammy";
import type { AppConfig } from "./config.js";
import type { TopicSession } from "./state.js";

const execFileAsync = promisify(execFile);
export const REALTIME_AUDIO_SAMPLE_RATE = 24_000;

export interface RealtimeAudioFrame {
  data: string;
  sampleRate: number;
  numChannels: number;
  samplesPerChannel: number;
  itemId: string;
}

export interface PreparedVoice {
  originalPath: string;
  pcmPath: string;
  wavPath: string;
  framePath: string;
  frame: RealtimeAudioFrame;
}

export async function prepareTelegramVoice(ctx: Context, config: AppConfig, topic: TopicSession): Promise<PreparedVoice> {
  const voice = ctx.message?.voice;
  if (!voice) {
    throw new Error("Telegram message does not contain a voice payload.");
  }

  const file = await ctx.api.getFile(voice.file_id);
  if (!file.file_path) {
    throw new Error("Telegram did not return a downloadable file path for this voice message.");
  }

  const messageId = ctx.message?.message_id ?? Date.now();
  const voiceDir = join(config.voiceDir, sanitizePathPart(topic.key), String(messageId));
  mkdirSync(voiceDir, { recursive: true });

  const originalPath = join(voiceDir, basename(file.file_path) || "voice.ogg");
  const pcmPath = join(voiceDir, "voice.pcm16le");
  const wavPath = join(voiceDir, "voice.wav");
  const framePath = join(voiceDir, "codex-realtime-audio-frame.json");

  const downloadUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
  await downloadFile(downloadUrl, originalPath, config.telegramProxy);

  await execFileAsync(config.ffmpegBin, [
    "-y",
    "-i",
    originalPath,
    "-ac",
    "1",
    "-ar",
    String(REALTIME_AUDIO_SAMPLE_RATE),
    "-f",
    "s16le",
    pcmPath,
  ]);

  await execFileAsync(config.ffmpegBin, [
    "-y",
    "-i",
    originalPath,
    "-ac",
    "1",
    "-ar",
    String(REALTIME_AUDIO_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    wavPath,
  ]);

  const pcm = readFileSync(pcmPath);
  const frame: RealtimeAudioFrame = {
    data: pcm.toString("base64"),
    sampleRate: REALTIME_AUDIO_SAMPLE_RATE,
    numChannels: 1,
    samplesPerChannel: Math.floor(pcm.length / 2),
    itemId: `telegram-voice-${messageId}`,
  };
  writeFileSync(framePath, `${JSON.stringify(frame, null, 2)}\n`, "utf8");

  return {
    originalPath,
    pcmPath,
    wavPath,
    framePath,
    frame,
  };
}

export function silenceAudioFrame(durationMs: number, itemId: string): RealtimeAudioFrame {
  const samples = Math.max(0, Math.floor((REALTIME_AUDIO_SAMPLE_RATE * durationMs) / 1000));
  return {
    data: Buffer.alloc(samples * 2).toString("base64"),
    sampleRate: REALTIME_AUDIO_SAMPLE_RATE,
    numChannels: 1,
    samplesPerChannel: samples,
    itemId,
  };
}

function downloadFile(url: string, outputPath: string, proxy?: string): Promise<void> {
  return new Promise((resolveDownload, rejectDownload) => {
    const options = proxy ? { agent: new HttpsProxyAgent(proxy) } : {};
    const req = httpsRequest(url, options, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        rejectDownload(new Error(`Telegram file download failed with HTTP ${status}.`));
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.once("error", rejectDownload);
      res.once("end", () => {
        writeFileSync(outputPath, Buffer.concat(chunks));
        resolveDownload();
      });
    });

    req.once("error", rejectDownload);
    req.end();
  });
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120) || "topic";
}
