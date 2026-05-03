import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GoalStatus = "active" | "paused" | "budget_limited" | "complete";

export interface ThreadGoal {
  threadId: string;
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export async function getThreadGoal(dbPath: string, threadId: string): Promise<ThreadGoal | undefined> {
  const rows = await sqliteJson<ThreadGoalRow>(
    dbPath,
    [
      "SELECT thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms",
      "FROM thread_goals",
      `WHERE thread_id = ${sqlString(threadId)}`,
      "LIMIT 1",
    ].join(" "),
  );
  return rows[0] ? mapGoal(rows[0]) : undefined;
}

export async function threadExists(dbPath: string, threadId: string): Promise<boolean> {
  const rows = await sqliteJson<{ found: number }>(
    dbPath,
    `SELECT 1 AS found FROM threads WHERE id = ${sqlString(threadId)} LIMIT 1`,
  );
  return rows.length > 0;
}

export async function setThreadGoalObjective(dbPath: string, threadId: string, objective: string): Promise<ThreadGoal> {
  const now = Date.now();
  await sqliteExec(
    dbPath,
    [
      "INSERT OR REPLACE INTO thread_goals",
      "(thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms)",
      "VALUES",
      [
        sqlString(threadId),
        sqlString(randomUUID()),
        sqlString(objective),
        sqlString("active"),
        "NULL",
        "0",
        "0",
        String(now),
        String(now),
      ].join(", ").replace(/^/, "(").replace(/$/, ")"),
    ].join(" "),
  );
  return requireGoal(dbPath, threadId);
}

export async function setThreadGoalStatus(dbPath: string, threadId: string, status: Extract<GoalStatus, "active" | "paused">): Promise<ThreadGoal> {
  await sqliteExec(
    dbPath,
    [
      "UPDATE thread_goals",
      `SET status = ${sqlString(status)}, updated_at_ms = ${Date.now()}`,
      `WHERE thread_id = ${sqlString(threadId)}`,
    ].join(" "),
  );
  return requireGoal(dbPath, threadId);
}

export async function clearThreadGoal(dbPath: string, threadId: string): Promise<boolean> {
  const before = await getThreadGoal(dbPath, threadId);
  if (!before) {
    return false;
  }
  await sqliteExec(dbPath, `DELETE FROM thread_goals WHERE thread_id = ${sqlString(threadId)}`);
  return true;
}

export function formatThreadGoal(goal: ThreadGoal): string {
  const lines = [
    "Goal",
    `Status: ${goalStatusLabel(goal.status)}`,
    `Objective: ${goal.objective}`,
    `Time used: ${formatElapsedSeconds(goal.timeUsedSeconds)}`,
    `Tokens used: ${formatTokensCompact(goal.tokensUsed)}`,
  ];
  if (goal.tokenBudget != null) {
    lines.push(`Token budget: ${formatTokensCompact(goal.tokenBudget)}`);
  }
  lines.push("", goalCommandHint(goal.status));
  return lines.join("\n");
}

function goalStatusLabel(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "budget_limited":
      return "limited by budget";
    case "complete":
      return "complete";
  }
}

function goalCommandHint(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "Commands: /goal pause, /goal clear";
    case "paused":
      return "Commands: /goal unpause, /goal clear";
    case "budget_limited":
    case "complete":
      return "Commands: /goal clear";
  }
}

function formatElapsedSeconds(input: number): string {
  const seconds = Math.max(0, Math.trunc(input));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.trunc(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.trunc(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function formatTokensCompact(input: number): string {
  const tokens = Math.max(0, Math.trunc(input));
  if (tokens < 1000) return String(tokens);
  const thousands = tokens / 1000;
  if (thousands < 10) return `${trimFixed(thousands, 1)}K`;
  if (thousands < 1000) return `${trimFixed(thousands, thousands < 100 ? 1 : 0)}K`;
  return `${trimFixed(thousands / 1000, 1)}M`;
}

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0$/, "");
}

async function requireGoal(dbPath: string, threadId: string): Promise<ThreadGoal> {
  const goal = await getThreadGoal(dbPath, threadId);
  if (!goal) {
    throw new Error(`No goal exists for thread ${threadId}.`);
  }
  return goal;
}

async function sqliteJson<T>(dbPath: string, sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" });
  const text = stdout.trim();
  return text ? (JSON.parse(text) as T[]) : [];
}

async function sqliteExec(dbPath: string, sql: string): Promise<void> {
  await execFileAsync("sqlite3", [dbPath, sql], { encoding: "utf8" });
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface ThreadGoalRow {
  thread_id: string;
  goal_id: string;
  objective: string;
  status: GoalStatus;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  created_at_ms: number;
  updated_at_ms: number;
}

function mapGoal(row: ThreadGoalRow): ThreadGoal {
  return {
    threadId: row.thread_id,
    goalId: row.goal_id,
    objective: row.objective,
    status: row.status,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}
