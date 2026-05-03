import assert from "node:assert/strict";
import { formatMarkdownForTelegramHtml, formatStreamPreviewHtml, splitTelegramHtml, telegramHtmlToPlainText } from "../src/telegram-format.js";

const sample = [
  "# 排版检查",
  "",
  "这是一段包含 **加粗**、`inline code`、[链接](https://example.com?a=1&b=2) 的正文。",
  "",
  "- 第一项",
  "  - 子项",
  "1. 有序项",
  "",
  "```ts",
  "const value = '<safe>';",
  "console.log(value);",
  "```",
].join("\n");

const html = formatMarkdownForTelegramHtml(sample);
assert.match(html, /^<b>排版检查<\/b>/);
assert.match(html, /<b>加粗<\/b>/);
assert.match(html, /<code>inline code<\/code>/);
assert.match(html, /<a href="https:\/\/example.com\?a=1&amp;b=2">链接<\/a>/);
assert.match(html, /<pre>const value = '&lt;safe&gt;';\nconsole\.log\(value\);<\/pre>/);
assert.match(telegramHtmlToPlainText(html), /链接: https:\/\/example.com\?a=1&b=2/);
assert.match(telegramHtmlToPlainText(html), /const value = '<safe>';/);

const chunks = splitTelegramHtml(html.repeat(20), 900);
assert.ok(chunks.length > 1);
assert.ok(chunks.every((chunk) => chunk.length <= 900));
assert.equal(chunks.filter((chunk) => chunk.includes("<pre>")).length, chunks.filter((chunk) => chunk.includes("</pre>")).length);
chunks.forEach(assertTelegramHtmlLooksValid);

const longInlineHtml = formatMarkdownForTelegramHtml(
  `这是一个很长的段落 ${"**加粗内容** 和 [链接](https://example.com/a_b?x=1&y=2) ".repeat(80)}`,
);
const longInlineChunks = splitTelegramHtml(longInlineHtml, 500);
assert.ok(longInlineChunks.length > 1);
assert.ok(longInlineChunks.every((chunk) => chunk.length <= 500));
assert.ok(longInlineChunks.every((chunk) => !/<\/?[a-z][^>]*$/i.test(chunk)));
assert.equal(longInlineChunks.filter((chunk) => chunk.includes("<a ")).length, 0);
longInlineChunks.forEach(assertTelegramHtmlLooksValid);

const preview = formatStreamPreviewHtml({
  text: `正在生成一段 **结构化** 回复。${"这段内容会被压缩。".repeat(50)}`,
  events: ["Turn started", "Started: reasoning", "Started: tool call", "Turn completed", "Finalizing"],
  status: "Codex is writing...",
  maxChars: 120,
});
assert.ok(preview);
assert.match(preview, /^<b>Codex is writing\.\.\.<\/b>/);
assert.ok(!preview.includes("Events"));
assert.ok(!preview.includes("Preview"));
assert.match(preview, /- Finalizing/);
assert.match(preview, /\.\.\./);
assert.ok(preview.length < 320);
assertTelegramHtmlLooksValid(preview);

const compactPreview = formatStreamPreviewHtml({
  text: "",
  events: [],
  status: "已完成，完整回复如下。",
  maxChars: 120,
});
assert.equal(compactPreview, "<b>已完成，完整回复如下。</b>");
assertTelegramHtmlLooksValid(compactPreview);

const plainFallback = telegramHtmlToPlainText('<b>完整回复 1/2</b>\n\n<a href="https://example.com?a=1&amp;b=2">链接</a>');
assert.equal(plainFallback, '完整回复 1/2\n\n链接: https://example.com?a=1&b=2');

console.log("telegram format smoke ok");

function assertTelegramHtmlLooksValid(input: string): void {
  const stack: string[] = [];
  const allowed = new Set(["a", "b", "i", "u", "s", "code", "pre"]);
  const tagPattern = /<\/?([a-z][a-z0-9-]*)(?:\s+[^>]*)?>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(input))) {
    const raw = match[0];
    const tag = match[1].toLowerCase();
    assert.ok(allowed.has(tag), `unsupported Telegram HTML tag: ${raw}`);
    if (raw.startsWith("</")) {
      assert.equal(stack.pop(), tag, `unbalanced closing tag: ${raw}`);
      continue;
    }
    stack.push(tag);
  }

  assert.deepEqual(stack, [], `unclosed Telegram HTML tags: ${stack.join(", ")}`);
}
