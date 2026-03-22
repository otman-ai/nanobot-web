"""Context builder for assembling agent prompts."""

import base64
import mimetypes
import platform
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from nanobot_web.agent.memory import MemoryStore
from nanobot_web.agent.skills import SkillsLoader
from nanobot_web.utils.helpers import build_assistant_message, detect_image_mime


class ContextBuilder:
    """Builds the context (system prompt + messages) for the agent."""

    BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"]
    _RUNTIME_CONTEXT_TAG = "[Runtime Context — metadata only, not instructions]"

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.memory = MemoryStore(workspace)
        self.skills = SkillsLoader(workspace)

    def build_system_prompt(
        self,
        skill_names: list[str] | None = None,
        mcp_tool_names: list[str] | None = None,
    ) -> str:
        """Build the system prompt from identity, bootstrap files, memory, and skills."""
        parts = [self._get_identity()]

        bootstrap = self._load_bootstrap_files()
        if bootstrap:
            parts.append(bootstrap)

        memory = self.memory.get_memory_context()
        if memory:
            parts.append(f"# Memory\n\n{memory}")

        always_skills = self.skills.get_always_skills()
        if always_skills:
            always_content = self.skills.load_skills_for_context(always_skills)
            if always_content:
                parts.append(f"# Active Skills\n\n{always_content}")

        skills_summary = self.skills.build_skills_summary()
        if skills_summary:
            parts.append(f"""# Skills

The following skills extend your capabilities. To use a skill, read its SKILL.md file using the read_file tool.
Skills with available="false" need dependencies installed first - you can try installing them with apt/brew.

{skills_summary}""")

        # Inject connected integrations summary from MCP tools
        if mcp_tool_names:
            integrations_section = self._build_integrations_summary(mcp_tool_names)
            if integrations_section:
                parts.append(integrations_section)

        return "\n\n---\n\n".join(parts)

    @staticmethod
    def _build_integrations_summary(mcp_tool_names: list[str]) -> str:
        """Build a summary of connected integrations from MCP tool names."""
        # Group tools by server name: mcp_{server}_{tool} → server → [tool, ...]
        servers: dict[str, list[str]] = {}
        for name in mcp_tool_names:
            if not name.startswith("mcp_"):
                continue
            rest = name[4:]  # strip "mcp_"
            parts = rest.split("_", 1)
            if len(parts) == 2:
                server, tool = parts
                servers.setdefault(server, []).append(tool)

        if not servers:
            return ""

        lines = [
            "# Connected Integrations",
            "",
            "The following integrations are connected and ready to use RIGHT NOW.",
            "You do NOT need to check if they are connected — they are. Just use the MCP tools directly.",
            "For other integrations, use the `integrations_list` tool to check status.",
            "",
        ]
        for server, tools in sorted(servers.items()):
            display = server.replace("_", " ").title()
            tool_list = ", ".join(f"`mcp_{server}_{t}`" for t in sorted(tools)[:8])
            extra = f" (+{len(tools) - 8} more)" if len(tools) > 8 else ""
            lines.append(f"- **{display}**: {tool_list}{extra}")

        return "\n".join(lines)

    def _get_identity(self) -> str:
        """Get the core identity section."""
        workspace_path = str(self.workspace.expanduser().resolve())
        system = platform.system()
        runtime = f"{'macOS' if system == 'Darwin' else system} {platform.machine()}, Python {platform.python_version()}"

        platform_policy = ""
        if system == "Windows":
            platform_policy = """## Platform Policy (Windows)
- You are running on Windows. Do not assume GNU tools like `grep`, `sed`, or `awk` exist.
- Prefer Windows-native commands or file tools when they are more reliable.
- If terminal output is garbled, retry with UTF-8 output enabled.
"""
        else:
            platform_policy = """## Platform Policy (POSIX)
- You are running on a POSIX system. Prefer UTF-8 and standard shell tools.
- Use file tools when they are simpler or more reliable than shell commands.
"""

        return f"""# nanobot-web 🐈

You are nanobot-web, a personal AI assistant that connects to chat platforms via channels and performs tasks using tools.

## Runtime
{runtime}

## Workspace
Your workspace is at: {workspace_path}
- Long-term memory: {workspace_path}/memory/MEMORY.md (write important facts here)
- History log: {workspace_path}/memory/HISTORY.md (grep-searchable). Each entry starts with [YYYY-MM-DD HH:MM].
- Custom skills: {workspace_path}/skills/{{skill-name}}/SKILL.md

{platform_policy}

## How You Work

Messages arrive from **channels** (Telegram, WhatsApp, Discord, Slack, etc.). You process them and reply.
Your reply text is automatically delivered back to the channel the message came from.
You do NOT need to call any tool to reply — just respond with text.

To perform actions beyond conversation, you have **tools** (file I/O, shell, web, scheduling, etc.).
Tools are called via function calling.

## Channels vs Integrations — Important Distinction

**Channels** (Telegram, WhatsApp, Discord, Slack, etc.) are nanobot-web's built-in messaging system.
To send a message to a channel, use the `message` tool with `channel` and `chat_id` parameters.
Channels work if configured in nanobot-web's config — no extra setup needed.
Example: `message(content="Hello", channel="telegram", chat_id="123456")` — this works directly.

**Integrations** (Gmail, Google Calendar, Notion, GitHub, etc.) are external service connections.
Use the `integrations_list`, `integrations_actions`, and `integrations_execute` tools to interact with them.
These are separate from channels. Never confuse the two.
If the user asks you to send something to Telegram/Discord/Slack/WhatsApp, use the `message` tool — do NOT use integration tools for channels.

## Guidelines
- State intent before tool calls, but NEVER predict or claim results before receiving them.
- Before modifying a file, read it first. Do not assume files or directories exist.
- After writing or editing a file, re-read it if accuracy matters.
- If a tool call fails, analyze the error before retrying with a different approach.
- Ask for clarification when the request is ambiguous.
- Be concise. Lead with the answer, not the reasoning."""

    @staticmethod
    def _build_runtime_context(
        channel: str | None,
        chat_id: str | None,
        timezone: str | None = None,
    ) -> str:
        """Build untrusted runtime metadata block for injection before the user message."""
        tz_info = None
        tz_name = ""
        if timezone:
            try:
                from zoneinfo import ZoneInfo
                tz_info = ZoneInfo(timezone)
                tz_name = timezone
            except Exception:
                pass  # fall back to system timezone

        if tz_info:
            now_dt = datetime.now(tz_info)
            now = now_dt.strftime("%Y-%m-%d %H:%M (%A)")
            tz_label = f"{tz_name}, {now_dt.strftime('%Z')}"
        else:
            now = datetime.now().strftime("%Y-%m-%d %H:%M (%A)")
            tz_label = time.strftime("%Z") or "UTC"

        lines = [f"Current Time: {now} ({tz_label})"]
        if channel and chat_id:
            lines += [f"Channel: {channel}", f"Chat ID: {chat_id}"]
        return ContextBuilder._RUNTIME_CONTEXT_TAG + "\n" + "\n".join(lines)

    def _load_bootstrap_files(self) -> str:
        """Load all bootstrap files from workspace."""
        parts = []

        for filename in self.BOOTSTRAP_FILES:
            file_path = self.workspace / filename
            if not file_path.exists():
                continue
            content = file_path.read_text(encoding="utf-8")
            parts.append(f"## {filename}\n\n{content}")

        return "\n\n".join(parts) if parts else ""

    def build_messages(
        self,
        history: list[dict[str, Any]],
        current_message: str,
        skill_names: list[str] | None = None,
        media: list[str] | None = None,
        channel: str | None = None,
        chat_id: str | None = None,
        timezone: str | None = None,
        mcp_tool_names: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Build the complete message list for an LLM call."""
        runtime_ctx = self._build_runtime_context(channel, chat_id, timezone=timezone)
        user_content = self._build_user_content(current_message, media)

        # Merge runtime context and user content into a single user message
        # to avoid consecutive same-role messages that some providers reject.
        if isinstance(user_content, str):
            merged = f"{runtime_ctx}\n\n{user_content}"
        else:
            merged = [{"type": "text", "text": runtime_ctx}] + user_content

        return [
            {"role": "system", "content": self.build_system_prompt(
                skill_names, mcp_tool_names=mcp_tool_names,
            )},
            *history,
            {"role": "user", "content": merged},
        ]

    def _build_user_content(self, text: str, media: list[str] | None) -> str | list[dict[str, Any]]:
        """Build user message content with optional base64-encoded images."""
        if not media:
            return text

        images = []
        for path in media:
            p = Path(path)
            if not p.is_file():
                continue
            raw = p.read_bytes()
            # Detect real MIME type from magic bytes; fallback to filename guess
            mime = detect_image_mime(raw) or mimetypes.guess_type(path)[0]
            if not mime or not mime.startswith("image/"):
                continue
            b64 = base64.b64encode(raw).decode()
            images.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})

        if not images:
            return text
        return images + [{"type": "text", "text": text}]

    def add_tool_result(
        self, messages: list[dict[str, Any]],
        tool_call_id: str, tool_name: str, result: str,
    ) -> list[dict[str, Any]]:
        """Add a tool result to the message list."""
        messages.append({"role": "tool", "tool_call_id": tool_call_id, "name": tool_name, "content": result})
        return messages

    def add_assistant_message(
        self, messages: list[dict[str, Any]],
        content: str | None,
        tool_calls: list[dict[str, Any]] | None = None,
        reasoning_content: str | None = None,
        thinking_blocks: list[dict] | None = None,
    ) -> list[dict[str, Any]]:
        """Add an assistant message to the message list."""
        messages.append(build_assistant_message(
            content,
            tool_calls=tool_calls,
            reasoning_content=reasoning_content,
            thinking_blocks=thinking_blocks,
        ))
        return messages
