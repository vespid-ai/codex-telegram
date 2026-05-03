# Codex Telegram Bridge

Telegram forum-topic bridge for Codex CLI. Each Telegram topic maps to one persisted Codex session; messages in the same topic resume the same session, while different topics can run independently.

## Why no tmux

tmux is useful for attaching to terminal UI processes, but it is the wrong source of truth for this bridge. The bot uses `codex exec --json` to create a persisted Codex session, then uses `codex exec resume <session-id>` for later messages in the same Telegram topic. The durable mapping is `chat_id + message_thread_id -> codex_session_id`.

## Setup

1. Create a Telegram bot with BotFather and add it to a supergroup with topics enabled.
2. Copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN`.
   If `api.telegram.org` is not reachable directly, set `TELEGRAM_PROXY`, for example `http://127.0.0.1:2333`.
3. Install and run:

```bash
npm install
npm run build
npm start
```

For local development:

```bash
npm run dev
```

## Long-running on macOS

Use `launchd`, not tmux:

```bash
cp .env.example .env
# edit .env and fill TELEGRAM_BOT_TOKEN
bash scripts/install-launchd.sh
```

Stop and remove the LaunchAgent:

```bash
bash scripts/uninstall-launchd.sh
```

Logs are written to `logs/launchd.out.log` and `logs/launchd.err.log`.

## Telegram Commands

- `/help` shows usage.
- `/status` shows the current topic mapping and busy state.
- `/session` shows the Codex session id for this topic.
- `/resume` lists recent Codex sessions for the current workspace in a Telegram-friendly format.
- `/resume --all` lists recent Codex sessions across all workspaces.
- `/resume <short-id|session-id|thread-name> [prompt]` binds this topic to an existing Codex session. Short ids are the 8-character prefixes shown by `/resume`. If a prompt is supplied, it is sent immediately.
- `/resume --last [prompt]` binds this topic to the latest Codex session in the current workspace. Add `--all` to ignore workspace filtering.
- `/cwd [path]` shows or switches this topic's Codex workspace. Switching workspace starts the next message in a fresh Codex session because existing Codex sessions cannot be safely moved to another cwd.
- `/new [prompt]` starts a fresh Codex session in this topic. If a prompt is supplied, it is sent immediately.
- `/reset` forgets this topic's Codex session but keeps the topic workspace; the next normal message creates a new session.
- `/cancel` terminates the currently running Codex process for this topic.

## Notes

- The bot should receive normal messages in topic threads. In a topic-enabled supergroup, Telegram includes `message_thread_id`; the bridge uses it as the session boundary.
- Messages in one topic are serialized. If Codex is still running, later messages in the same topic wait their turn.
- Codex can keep producing Markdown, but long Telegram replies are normalized before sending: headings, links, lists, inline code, emphasis, and fenced code blocks are converted to a simpler Telegram-readable text form.
- While Codex is running, assistant text events are shown as a throttled Telegram preview message; the final complete answer is still sent after the run finishes.
- Attachments are not bridged yet. The first production-worthy extension is downloading Telegram photos/files and passing them to Codex with `--image`.

## License

MIT
