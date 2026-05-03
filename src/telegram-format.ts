export interface StreamPreviewOptions {
  text: string;
  events: string[];
  status: string;
  maxChars: number;
}

export function formatStreamPreviewHtml(options: StreamPreviewOptions): string | undefined {
  const source =
    options.text.length > options.maxChars
      ? `...${options.text.slice(Math.max(0, options.text.length - options.maxChars)).trimStart()}`
      : options.text;
  const preview = formatMarkdownForTelegramHtml(source).trim();

  const parts = [`<b>${escapeHtml(options.status)}</b>`];
  const recentEvents = options.events
    .map(formatProgressEvent)
    .filter((event): event is string => Boolean(event))
    .slice(-3);
  if (recentEvents.length > 0) {
    parts.push(recentEvents.map((event) => `- ${escapeHtml(event)}`).join("\n"));
  }
  if (preview) {
    parts.push(preview);
  }
  return parts.join("\n\n");
}

function formatProgressEvent(input: string): string | undefined {
  const normalized = input.replace(/^\d{2}:\d{2}:\d{2}\s+/, "").trim();
  if (!normalized) {
    return undefined;
  }
  if (/^(Turn started|Session started|App-server session started|App-server session resumed)$/i.test(normalized)) {
    return "会话已启动";
  }
  if (/^(Turn completed)$/i.test(normalized)) {
    return "回复已生成";
  }
  if (/assistant message/i.test(normalized)) {
    return "正在整理回复";
  }
  if (/reasoning/i.test(normalized)) {
    return "正在思考";
  }
  if (/tool output/i.test(normalized)) {
    return "工具已返回结果";
  }
  if (/tool call|function_call/i.test(normalized)) {
    return "正在调用工具";
  }
  if (/realtime/i.test(normalized)) {
    return "语音会话进行中";
  }
  return normalized.length > 80 ? `${normalized.slice(0, 79)}...` : normalized;
}

export function splitTelegramHtml(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [safeTelegramHtmlChunk(text)];
  }

  const chunks: string[] = [];
  let current = "";
  for (const block of collectTelegramHtmlBlocks(text)) {
    const parts = splitOversizedHtmlBlock(block, maxChars);
    for (const rawPart of parts) {
      const part = safeTelegramHtmlChunk(rawPart);
      const next = current ? `${current}\n\n${part}` : part;
      if (next.length <= maxChars) {
        current = next;
        continue;
      }
      if (current) {
        chunks.push(current);
      }
      current = part;
    }
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function safeTelegramHtmlChunk(input: string): string {
  return hasBalancedTelegramHtmlTags(input) ? input : stripTelegramHtmlTags(input);
}

function hasBalancedTelegramHtmlTags(input: string): boolean {
  const stack: string[] = [];
  const tagPattern = /<\/?([a-z][a-z0-9-]*)(?:\s+[^>]*)?>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(input))) {
    const raw = match[0];
    const tag = match[1].toLowerCase();
    if (!["a", "b", "i", "u", "s", "code", "pre"].includes(tag)) {
      return false;
    }
    if (raw.startsWith("</")) {
      if (stack.pop() !== tag) {
        return false;
      }
      continue;
    }
    stack.push(tag);
  }

  return stack.length === 0;
}

function collectTelegramHtmlBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split("\n");
  let current: string[] = [];
  let inPre = false;

  for (const line of lines) {
    const startsPre = line.startsWith("<pre>");
    if (!inPre && line === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }

    current.push(line);
    if (startsPre && !line.endsWith("</pre>")) {
      inPre = true;
      continue;
    }
    if (inPre && line.endsWith("</pre>")) {
      inPre = false;
    }
  }

  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }
  return blocks;
}

function splitOversizedHtmlBlock(block: string, maxChars: number): string[] {
  if (block.length <= maxChars) {
    return [block];
  }

  const pre = /^<pre>([\s\S]*)<\/pre>$/.exec(block);
  if (pre) {
    const overhead = "<pre></pre>".length;
    return splitText(pre[1], Math.max(200, maxChars - overhead)).map((chunk) => `<pre>${chunk}</pre>`);
  }

  const safeBlock = /<\/?[a-z][^>]*>/i.test(block) ? stripTelegramHtmlTags(block) : block;
  return splitText(safeBlock, maxChars);
}

export function telegramHtmlToPlainText(input: string): string {
  return decodeHtmlEntities(stripTelegramHtmlTags(input));
}

function stripTelegramHtmlTags(input: string): string {
  return input
    .replace(/<a\s+href="([^"]*)">([\s\S]*?)<\/a>/gi, (_match, url: string, label: string) =>
      label === url ? url : `${label}: ${url}`,
    )
    .replace(/<\/?(?:b|strong|i|em|u|s|strike|del|code|tg-spoiler)[^>]*>/gi, "")
    .replace(/<tg-emoji\s+emoji-id="[^"]*">([\s\S]*?)<\/tg-emoji>/gi, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "");
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
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

export function formatMarkdownForTelegramHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCodeBlock) {
        pushBlock(output, renderCodeBlock(codeLines));
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line.replace(/\s+$/g, ""));
      continue;
    }

    output.push(formatMarkdownLineForTelegramHtml(line));
  }

  if (inCodeBlock && codeLines.length > 0) {
    pushBlock(output, renderCodeBlock(codeLines));
  }

  return output
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function pushBlock(output: string[], block: string): void {
  if (!block) {
    return;
  }
  if (output.length > 0 && output[output.length - 1] !== "") {
    output.push("");
  }
  output.push(block);
  output.push("");
}

function renderCodeBlock(lines: string[]): string {
  const body = lines.join("\n").trimEnd();
  return body ? `<pre>${escapeHtml(body)}</pre>` : "";
}

function formatMarkdownLineForTelegramHtml(line: string): string {
  const next = line.replace(/\s+$/g, "");

  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(next)) {
    return "";
  }

  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(next);
  if (heading) {
    return `<b>${formatInlineMarkdownForTelegramHtml(heading[1])}</b>`;
  }

  if (/^\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+$/.test(next.trim())) {
    return "";
  }

  const task = /^(\s*)[-*+]\s+\[( |x|X)\]\s+(.+)$/.exec(next);
  if (task) {
    return `${formatListIndent(task[1])}- [${task[2].toLowerCase() === "x" ? "x" : " "}] ${formatInlineMarkdownForTelegramHtml(task[3])}`;
  }

  const bullet = /^(\s*)[-*+]\s+(.+)$/.exec(next);
  if (bullet) {
    return `${formatListIndent(bullet[1])}- ${formatInlineMarkdownForTelegramHtml(bullet[2])}`;
  }

  const ordered = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(next);
  if (ordered) {
    return `${formatListIndent(ordered[1])}${ordered[2]}. ${formatInlineMarkdownForTelegramHtml(ordered[3])}`;
  }

  const quote = /^(\s*)>\s?(.*)$/.exec(next);
  if (quote) {
    return `${formatListIndent(quote[1])}&gt; ${formatInlineMarkdownForTelegramHtml(quote[2])}`;
  }

  if (/^\s*\|.+\|\s*$/.test(next)) {
    return next
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim())
      .map(formatInlineMarkdownForTelegramHtml)
      .join("  |  ");
  }

  return formatInlineMarkdownForTelegramHtml(next);
}

function formatListIndent(input: string): string {
  const depth = Math.min(4, Math.floor(input.replace(/\t/g, "  ").length / 2));
  return "  ".repeat(depth);
}

function formatInlineMarkdownForTelegramHtml(input: string): string {
  let next = escapeHtml(input);

  next = next.replace(
    /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_match, alt: string, url: string) => (alt ? `${alt}: <a href="${url}">${url}</a>` : `<a href="${url}">${url}</a>`),
  );
  next = next.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_match, label: string, url: string) => (label === url ? `<a href="${url}">${url}</a>` : `<a href="${url}">${label}</a>`),
  );
  next = next.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  next = next.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  next = next.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  next = next.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  next = next.replace(/(^|[\s([{])\*([^*\n]+)\*(?=[\s)\]},.!?:;]|$)/g, "$1<i>$2</i>");
  next = next.replace(/(^|[\s([{])_([^_\n]+)_(?=[\s)\]},.!?:;]|$)/g, "$1<i>$2</i>");
  return next;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
