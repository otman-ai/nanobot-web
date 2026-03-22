# CLAUDE.md

## Project Overview

Epicbott is an ultra-lightweight personal AI assistant framework (~2,800 core LOC). It connects multiple chat platforms to LLM providers via a message bus architecture. Package name: `nanobot-web` on PyPI.

- **Python:** 3.11+
- **License:** MIT
- **Entry point:** `nanobot_web.cli.commands:app` (Typer CLI)

## Quick Reference

```bash
# Install
pip install nanobot-web
pip install "nanobot-web[web]"      # with web UI
pip install "nanobot-web[dev]"      # with dev tools

# Setup
nanobot-web onboard                     # initialize config + workspace

# Run
nanobot-web agent -m "Hello"            # single message
nanobot-web agent                       # interactive mode
nanobot-web gateway --port 18790        # all channels + cron + heartbeat
nanobot-web web --host 127.0.0.1        # web API server

# Config
nanobot-web config get providers.anthropic.api_key
nanobot-web config set agents.defaults.model "anthropic/claude-opus-4-5"
nanobot-web status                      # show config and API key status
```

## Testing

```bash
pytest tests/ -v
```

- Uses `pytest-asyncio` with `asyncio_mode = "auto"`
- Test directory: `tests/` (30+ test files)

## Linting

```bash
ruff check nanobot_web/
```

- Line length: 100 (E501 ignored)
- Target: Python 3.11
- Rules: E, F, I, N, W

## Architecture

```
Chat Platforms → Channels → MessageBus → AgentLoop → LLM Providers
                                ↕
                        Tools / Memory / Skills
```

**Key modules:**

| Path | Purpose |
|------|---------|
| `nanobot_web/agent/loop.py` | Core agent processing loop (up to 40 tool iterations) |
| `nanobot_web/agent/context.py` | System prompt assembly and token management |
| `nanobot_web/agent/memory.py` | Two-layer memory (MEMORY.md + HISTORY.md) |
| `nanobot_web/agent/skills.py` | Skill loading and discovery |
| `nanobot_web/agent/tools/` | Tool implementations (filesystem, shell, web, MCP, cron, spawn) |
| `nanobot_web/channels/` | 13 chat platform integrations (Telegram, Discord, Slack, etc.) |
| `nanobot_web/channels/manager.py` | Channel initialization and message routing |
| `nanobot_web/providers/` | 20+ LLM providers via registry + LiteLLM |
| `nanobot_web/config/schema.py` | Pydantic config models (camelCase JSON aliases) |
| `nanobot_web/config/loader.py` | Config loading/saving |
| `nanobot_web/cli/commands.py` | All CLI commands (Typer) |
| `nanobot_web/bus/queue.py` | Async message bus (inbound/outbound queues) |
| `nanobot_web/cron/service.py` | Scheduled task execution |
| `nanobot_web/session/manager.py` | Per-session history tracking |
| `nanobot_web/web/server.py` | FastAPI web API |
| `nanobot_web/templates/` | Workspace templates (AGENTS.md, SOUL.md, TOOLS.md, etc.) |
| `nanobot_web/skills/` | Built-in skill plugins |
| `bridge/` | Node.js WhatsApp bridge |

## Configuration

- **Config file:** `~/.nanobot_web/config.json` (Pydantic-validated)
- **Workspace:** `~/.nanobot_web/workspace/` (memory, sessions, skills, cron jobs)
- Config uses camelCase aliases for JSON serialization (e.g., `max_tokens` → `maxTokens`)

## Key Patterns

- **Message bus:** Async queues decouple channels from agent logic
- **Tool registry:** Each tool extends `BaseTool` with async `execute()` method
- **Channel abstraction:** `BaseChannel` with `start()`, `stop()`, `send()` methods
- **Provider auto-detection:** Model prefix matching (e.g., `deepseek/...` → Deepseek provider)
- **MCP support:** Lazy connection, stdio and HTTP/SSE transports
- **Session key format:** `{channel}:{chat_id}`

## Build & Distribution

- Build backend: `hatchling`
- Docker: Python 3.12 + Node.js 20 (for WhatsApp bridge), port 18790
- `docker-compose.yml` available for deployment
