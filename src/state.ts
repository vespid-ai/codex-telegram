import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TopicSession {
  key: string;
  chatId: number;
  threadId: number;
  codexSessionId?: string;
  workspace?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  lastPrompt?: string;
}

interface PersistedState {
  version: 1;
  topics: Record<string, TopicSession>;
}

export class StateStore {
  private state: PersistedState;

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  get(key: string): TopicSession | undefined {
    return this.state.topics[key];
  }

  upsert(input: Omit<TopicSession, "createdAt" | "updatedAt"> & Partial<Pick<TopicSession, "createdAt">>): TopicSession {
    const now = new Date().toISOString();
    const existing = this.state.topics[input.key];
    const next: TopicSession = {
      ...existing,
      ...input,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    };
    this.state.topics[input.key] = next;
    this.save();
    return next;
  }

  forget(key: string): boolean {
    const existed = Boolean(this.state.topics[key]);
    delete this.state.topics[key];
    if (existed) {
      this.save();
    }
    return existed;
  }

  setSessionId(key: string, sessionId: string): TopicSession {
    const existing = this.state.topics[key];
    if (!existing) {
      throw new Error(`Cannot set session id for unknown topic: ${key}`);
    }
    return this.upsert({ ...existing, codexSessionId: sessionId });
  }

  private load(): PersistedState {
    if (!existsSync(this.filePath)) {
      return { version: 1, topics: {} };
    }

    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedState;
    if (parsed.version !== 1 || typeof parsed.topics !== "object") {
      throw new Error(`Unsupported state file format: ${this.filePath}`);
    }
    return parsed;
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    renameSync(tmpPath, this.filePath);
  }
}

export function topicKey(chatId: number, threadId?: number): string {
  return `${chatId}:${threadId ?? 0}`;
}
