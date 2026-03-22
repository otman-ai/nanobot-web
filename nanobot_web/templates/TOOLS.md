# Tool Usage Notes

Tool signatures are provided automatically via function calling.
This file documents non-obvious constraints and best practices.

## exec — Safety Limits

- Commands have a configurable timeout (default 60s, max 600s)
- Dangerous commands are blocked (rm -rf, format, dd, shutdown, etc.)
- Output is truncated at 10,000 characters
- `restrictToWorkspace` config can limit file access to the workspace

## message — Delivery Rules

- Your text reply is automatically delivered to the current channel. You do NOT need to call `message` for normal replies.
- Use `message` only when you need to send to a **different** channel/chat, or when delivering results from a scheduled task.
- **Cross-channel delivery is fully supported**: you can send from any session (web, CLI, cron) to any configured channel by specifying the `channel` and `chat_id` parameters.
- When the user gives you a chat ID for a different platform, **immediately use the `message` tool** — do not ask them to "connect" or "link" anything. The channel is already configured in nanobot-web if it has a bot token in the config.
- Always use lowercase channel names: `telegram`, `whatsapp`, `discord`, `slack`, etc.
- Never pass channel names with capital letters (e.g., use `telegram` not `Telegram`).
- **Channels are NOT integrations.** Telegram, Discord, Slack, WhatsApp are nanobot-web built-in channels. Do not use `integrations_*` tools for them. Just call `message(channel="telegram", chat_id="...")` directly.

## integrations — External Services

- Use `integrations_list` to check available services and connection status.
- Use `integrations_connect` to start an OAuth flow — it returns a URL for the user.
- Use `integrations_actions` to discover what actions are available for a connected service.
- Use `integrations_execute` to run an action (e.g. send email, create calendar event).
- Do NOT ask the user for API keys, OAuth tokens, or credentials — the tools handle auth automatically.

## cron — Scheduled Tasks

- Use the `cron` tool directly. Do not call `nanobot-web cron` via `exec`.
- The current channel and chat ID are captured automatically — you don't need to specify them.
- Supports: `every_seconds` (interval), `cron_expr` with optional `tz` (cron schedule), `at` (one-time ISO datetime).
- Refer to the cron skill for detailed usage patterns.

## spawn — Subagents

- Use `spawn` for tasks that can run in the background while you continue the conversation.
- The subagent has access to the same tools but runs independently.

## File Tools — Best Practices

- Always `read_file` before `edit_file` — you need to know the current content.
- `edit_file` uses fuzzy matching for `old_text` — minor whitespace differences are tolerated.
- `list_dir` auto-ignores noise directories (.git, node_modules, __pycache__).
