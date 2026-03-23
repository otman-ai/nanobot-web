"""Web API for nanobot-web UI."""

from __future__ import annotations

import asyncio
import json
import shutil
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from loguru import logger
from pydantic import BaseModel

from nanobot_web.agent.loop import AgentLoop
from nanobot_web.agent.skills import SkillsLoader
from nanobot_web.bus.queue import MessageBus
from nanobot_web.config.editor import deep_merge, resolve_config_path, set_path_value
from nanobot_web.config.loader import get_config_path, load_config, save_config
from nanobot_web.config.schema import Config
from nanobot_web.cron.service import CronService
from nanobot_web.providers.base import GenerationSettings
from nanobot_web.session.manager import SessionManager

# Module-level flag: set to True by the CLI before uvicorn.run() to start
# channels, cron, and heartbeat alongside the web server.
_run_gateway = False


@asynccontextmanager
async def _lifespan(application: FastAPI):
    """Start gateway services (channels, cron, heartbeat) if enabled."""
    if not _run_gateway:
        yield
        return

    from nanobot_web.channels.manager import ChannelManager
    from nanobot_web.config.paths import get_cron_dir
    from nanobot_web.cron.types import CronJob
    from nanobot_web.heartbeat.service import HeartbeatService

    config = load_config()

    # Workspace templates
    from nanobot_web.cli.commands import sync_workspace_templates
    sync_workspace_templates(config.workspace_path)

    bus = MessageBus()
    provider = _make_provider(config)
    session_manager = SessionManager(config.workspace_path)

    # Cron
    cron_store_path = get_cron_dir() / "jobs.json"
    cron = CronService(cron_store_path)

    # Agent (long-lived, for gateway dispatching)
    agent = AgentLoop(
        bus=bus,
        provider=provider,
        workspace=config.workspace_path,
        model=config.agents.defaults.model,
        max_iterations=config.agents.defaults.max_tool_iterations,
        context_window_tokens=config.agents.defaults.context_window_tokens,
        brave_api_key=config.tools.web.search.api_key or None,
        web_proxy=config.tools.web.proxy or None,
        exec_config=config.tools.exec,
        tools_config=config.tools,
        cron_service=cron,
        restrict_to_workspace=config.tools.restrict_to_workspace,
        session_manager=session_manager,
        mcp_servers=config.tools.mcp_servers,
        channels_config=config.channels,
        timezone=config.agents.defaults.timezone or None,
    )

    # Cron callback
    async def on_cron_job(job: CronJob) -> str | None:
        from nanobot_web.agent.tools.cron import CronTool
        from nanobot_web.agent.tools.message import MessageTool
        reminder_note = (
            "[Scheduled Task] Timer finished.\n\n"
            f"Task '{job.name}' has been triggered.\n"
            f"Scheduled instruction: {job.payload.message}"
        )
        cron_tool = agent.tools.get("cron")
        cron_token = None
        if isinstance(cron_tool, CronTool):
            cron_token = cron_tool.set_cron_context(True)
        try:
            response = await agent.process_direct(
                reminder_note,
                session_key=f"cron:{job.id}",
                channel=job.payload.channel or "cli",
                chat_id=job.payload.to or "direct",
            )
        finally:
            if isinstance(cron_tool, CronTool) and cron_token is not None:
                cron_tool.reset_cron_context(cron_token)

        message_tool = agent.tools.get("message")
        if isinstance(message_tool, MessageTool) and message_tool._sent_in_turn:
            return response

        if job.payload.deliver and job.payload.to and response:
            from nanobot_web.bus.events import OutboundMessage
            await bus.publish_outbound(OutboundMessage(
                channel=job.payload.channel or "cli",
                chat_id=job.payload.to,
                content=response,
            ))
        return response

    cron.on_job = on_cron_job

    # Channels
    channels = ChannelManager(config, bus)

    # Heartbeat
    def _pick_heartbeat_target() -> tuple[str, str]:
        enabled = set(channels.enabled_channels)
        for item in session_manager.list_sessions():
            key = item.get("key") or ""
            if ":" not in key:
                continue
            channel, chat_id = key.split(":", 1)
            if channel in {"cli", "system"}:
                continue
            if channel in enabled and chat_id:
                return channel, chat_id
        return "cli", "direct"

    async def on_heartbeat_execute(tasks: str) -> str:
        channel, chat_id = _pick_heartbeat_target()
        return await agent.process_direct(
            tasks, session_key="heartbeat", channel=channel, chat_id=chat_id,
            on_progress=lambda *a, **kw: asyncio.sleep(0),
        )

    async def on_heartbeat_notify(response: str) -> None:
        from nanobot_web.bus.events import OutboundMessage
        channel, chat_id = _pick_heartbeat_target()
        if channel == "cli":
            return
        await bus.publish_outbound(OutboundMessage(channel=channel, chat_id=chat_id, content=response))

    hb_cfg = config.gateway.heartbeat
    heartbeat = HeartbeatService(
        workspace=config.workspace_path,
        provider=provider,
        model=agent.model,
        on_execute=on_heartbeat_execute,
        on_notify=on_heartbeat_notify,
        interval_s=hb_cfg.interval_s,
        enabled=hb_cfg.enabled,
    )

    if channels.enabled_channels:
        logger.info("Gateway channels enabled: {}", ", ".join(channels.enabled_channels))

    # Config file watcher — hot-reloads channels when config changes on disk
    async def _watch_config():
        cfg_path = get_config_path()
        last_mtime = cfg_path.stat().st_mtime if cfg_path.exists() else 0
        while True:
            await asyncio.sleep(3)
            try:
                if not cfg_path.exists():
                    continue
                mtime = cfg_path.stat().st_mtime
                if mtime <= last_mtime:
                    continue
                last_mtime = mtime
                new_config = load_config(cfg_path)
                logger.info("Config file changed, reloading gateway services...")
                await channels.reload_config(new_config)
                if channels.enabled_channels:
                    logger.info("Channels after reload: {}", ", ".join(channels.enabled_channels))
            except Exception as e:
                logger.error("Config reload failed: {}", e)

    # Start background services
    await cron.start()
    await heartbeat.start()
    gateway_tasks = asyncio.gather(
        agent.run(),
        channels.start_all(),
        _watch_config(),
    )

    logger.info("Gateway services started alongside web server")

    try:
        yield
    finally:
        # Shutdown gateway services
        gateway_tasks.cancel()
        await agent.close_mcp()
        heartbeat.stop()
        cron.stop()
        agent.stop()
        await channels.stop_all()
        logger.info("Gateway services stopped")


app = FastAPI(title="nanobot-web web", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConfigSetRequest(BaseModel):
    path: str
    value: Any


class ConfigMergeRequest(BaseModel):
    patch: dict[str, Any]


class ChatRequest(BaseModel):
    message: str
    session_id: str = "web:default"
    tools_enabled: list[str] | None = None
    config_path: str | None = None


class IntegrationConnectRequest(BaseModel):
    toolkit: str


class IntegrationDisconnectRequest(BaseModel):
    toolkit: str


class CronJobEnableRequest(BaseModel):
    job_id: str
    enabled: bool = True


class CronJobRunRequest(BaseModel):
    job_id: str
    force: bool = False


class CronJobRemoveRequest(BaseModel):
    job_id: str


class CronJobCreateRequest(BaseModel):
    name: str
    schedule_kind: str  # "every" | "cron" | "at"
    # For "every": interval in minutes
    every_minutes: int | None = None
    # For "cron": cron expression
    cron_expr: str | None = None
    # For "cron": timezone
    cron_tz: str | None = None
    # For "at": ISO datetime string
    at_datetime: str | None = None
    # Payload
    message: str = ""
    deliver: bool = False
    channel: str | None = None
    to: str | None = None
    delete_after_run: bool = False


class PromptSaveRequest(BaseModel):
    content: str


class MemoryDeleteRequest(BaseModel):
    filename: str


class SkillDeleteRequest(BaseModel):
    name: str


# Max knowledge files a user can upload
MAX_KNOWLEDGE_FILES = 20
# Max file size for knowledge uploads (10 MB)
MAX_KNOWLEDGE_FILE_SIZE = 10 * 1024 * 1024

INTEGRATION_TOOLKITS = [
    {"id": "googlecalendar", "label": "Google Calendar"},
    {"id": "gmail", "label": "Gmail"},
    {"id": "outlook", "label": "Outlook"},
    {"id": "monday", "label": "Monday MCP"},
    {"id": "notion", "label": "Notion"},
    {"id": "shopify", "label": "Shopify"},
    {"id": "googledrive", "label": "Google Drive"},
    {"id": "hubspot", "label": "Hubspot"},
]


TOOL_GROUPS: dict[str, list[str]] = {
    "web": ["web_search", "web_fetch", "google_search"],
    "services": ["weather", "news", "wolfram_alpha"],
    "integrations": ["integrations_list", "integrations_connect", "integrations_actions", "integrations_execute"],
    "message": ["message"],
    "spawn": ["spawn"],
    "cron": ["cron"],
    "mcp": [],
}


def _make_provider(config: Config):
    """Create the appropriate LLM provider from config."""
    from nanobot_web.providers.openai_codex_provider import OpenAICodexProvider
    from nanobot_web.providers.azure_openai_provider import AzureOpenAIProvider

    model = config.agents.defaults.model
    provider_name = config.get_provider_name(model)
    p = config.get_provider(model)

    # OpenAI Codex (OAuth)
    if provider_name == "openai_codex" or model.startswith("openai-codex/"):
        provider = OpenAICodexProvider(default_model=model)
    # Custom: direct OpenAI-compatible endpoint, bypasses LiteLLM
    elif provider_name == "custom":
        from nanobot_web.providers.custom_provider import CustomProvider
        provider = CustomProvider(
            api_key=p.api_key if p else "no-key",
            api_base=config.get_api_base(model) or "http://localhost:8000/v1",
            default_model=model,
        )
    # Azure OpenAI: direct Azure OpenAI endpoint with deployment name
    elif provider_name == "azure_openai":
        if not p or not p.api_key or not p.api_base:
            missing = []
            if not p or not p.api_key:
                missing.append("api_key")
            if not p or not p.api_base:
                missing.append("api_base")
            lines = [
                "",
                f"  \u274c Azure OpenAI requires: {', '.join(missing)}",
                "",
                "  Fix:",
                "",
            ]
            if "api_key" in missing:
                lines.append('    nanobot-web config set providers.azure_openai.api_key "YOUR_KEY"')
            if "api_base" in missing:
                lines.append('    nanobot-web config set providers.azure_openai.api_base "https://YOUR_RESOURCE.openai.azure.com"')
            lines += ["", "  Then re-run:  nanobot-web web", ""]
            import sys
            sys.stderr.write("\n".join(lines) + "\n")
            raise HTTPException(
                status_code=400,
                detail="Azure OpenAI requires api_key and api_base under providers.azure_openai",
            )
        provider = AzureOpenAIProvider(
            api_key=p.api_key,
            api_base=p.api_base,
            default_model=model,
        )
    else:
        from nanobot_web.providers.litellm_provider import LiteLLMProvider
        from nanobot_web.providers.registry import find_by_name
        spec = find_by_name(provider_name)
        import os
        has_env_key = spec and spec.env_key and os.environ.get(spec.env_key)
        if not model.startswith("bedrock/") and not (p and p.api_key) and not has_env_key and not (spec and (spec.is_oauth or spec.is_local)):
            display = (spec.display_name or provider_name) if spec else provider_name
            env_hint = spec.env_key if spec else None
            lines = [
                "",
                f"  \u274c No API key configured for provider '{display}' (model: {model})",
                "",
                "  Fix with ONE of these options:",
                "",
                f"    1. nanobot-web config set providers.{provider_name}.api_key \"YOUR_KEY\"",
            ]
            if env_hint:
                lines.append(f"    2. export {env_hint}=\"YOUR_KEY\"")
            lines += [
                "",
                "  Then re-run:  nanobot-web web",
                "",
            ]
            import sys
            sys.stderr.write("\n".join(lines) + "\n")
            raise HTTPException(status_code=400, detail="No API key configured for selected model/provider")
        provider = LiteLLMProvider(
            api_key=p.api_key if p else None,
            api_base=config.get_api_base(model),
            default_model=model,
            extra_headers=p.extra_headers if p else None,
            provider_name=provider_name,
        )

    defaults = config.agents.defaults
    provider.generation = GenerationSettings(
        temperature=defaults.temperature,
        max_tokens=defaults.max_tokens,
        reasoning_effort=defaults.reasoning_effort,
    )
    return provider


def _apply_tool_policy(agent: AgentLoop, tools_enabled: list[str] | None) -> None:
    if not tools_enabled:
        return
    enabled = set()
    for item in tools_enabled:
        enabled.update(TOOL_GROUPS.get(item, []))
        enabled.add(item)
    for name in agent.tools.tool_names:
        if name not in enabled:
            agent.tools.unregister(name)


def _tool_policy_mcp_enabled(tools_enabled: list[str] | None) -> bool:
    if not tools_enabled:
        return True
    return "mcp" in tools_enabled


def _cron_store_path(config: Config) -> Path:
    return (config.workspace_path / ".web") / "cron_jobs.json"


def _cron_job_to_dict(job) -> dict[str, Any]:
    return {
        "id": job.id,
        "name": job.name,
        "enabled": job.enabled,
        "schedule": {
            "kind": job.schedule.kind,
            "atMs": job.schedule.at_ms,
            "everyMs": job.schedule.every_ms,
            "expr": job.schedule.expr,
            "tz": job.schedule.tz,
        },
        "payload": {
            "kind": job.payload.kind,
            "message": job.payload.message,
            "deliver": job.payload.deliver,
            "channel": job.payload.channel,
            "to": job.payload.to,
        },
        "state": {
            "nextRunAtMs": job.state.next_run_at_ms,
            "lastRunAtMs": job.state.last_run_at_ms,
            "lastStatus": job.state.last_status,
            "lastError": job.state.last_error,
        },
        "createdAtMs": job.created_at_ms,
        "updatedAtMs": job.updated_at_ms,
        "deleteAfterRun": job.delete_after_run,
    }


def _get_composio_toolset(config: Config | None = None):
    import os
    from composio import ComposioToolSet

    if config is None:
        config = load_config()
    api_key = config.tools.composio_api_key or os.environ.get("COMPOSIO_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="Composio API key not configured. Add it in Settings or set COMPOSIO_API_KEY.",
        )
    return ComposioToolSet(api_key=api_key)


def _extract_url(payload: dict | list | str) -> str | None:
    import re

    if isinstance(payload, str):
        match = re.search(r"https?://\\S+", payload)
        return match.group(0) if match else None
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, dict):
                for key, value in item.items():
                    if isinstance(value, str) and value.startswith("http"):
                        return value
    if isinstance(payload, dict):
        for key in ("url", "auth_url", "authorization_url", "redirect_url", "link"):
            value = payload.get(key)
            if isinstance(value, str) and value.startswith("http"):
                return value
        for value in payload.values():
            if isinstance(value, str) and value.startswith("http"):
                return value
    return None


async def _build_agent(config: Config, cron, tools_enabled: list[str] | None = None) -> AgentLoop:
    provider = _make_provider(config)
    bus = MessageBus()
    session_manager = SessionManager(config.workspace_path)
    agent = AgentLoop(
        bus=bus,
        provider=provider,
        workspace=config.workspace_path,
        model=config.agents.defaults.model,
        max_iterations=config.agents.defaults.max_tool_iterations,
        context_window_tokens=config.agents.defaults.context_window_tokens,
        brave_api_key=config.tools.web.search.api_key or None,
        web_proxy=config.tools.web.proxy or None,
        exec_config=config.tools.exec,
        tools_config=config.tools,
        cron_service=cron,
        restrict_to_workspace=config.tools.restrict_to_workspace,
        session_manager=session_manager,
        mcp_servers=config.tools.mcp_servers if _tool_policy_mcp_enabled(tools_enabled) else {},
        channels_config=config.channels,
        timezone=config.agents.defaults.timezone or None,
    )
    _apply_tool_policy(agent, tools_enabled)
    return agent


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/channels/enabled")
def channels_enabled():
    """List channels that are enabled in config (available for delivery)."""
    config = load_config()
    from nanobot_web.channels.registry import discover_channel_names
    available = discover_channel_names()
    enabled = []
    for name in available:
        section = getattr(config.channels, name, None)
        if section and getattr(section, "enabled", False):
            enabled.append(name)
    return {"channels": sorted(enabled)}


@app.post("/api/onboarding/complete")
def onboarding_complete():
    """Sync workspace templates after onboarding finishes."""
    from nanobot_web.utils.helpers import sync_workspace_templates
    config = load_config()
    added = sync_workspace_templates(config.workspace_path, silent=True)
    return {"ok": True, "synced": added}


@app.get("/api/onboarding/status")
def onboarding_status():
    """Check whether onboarding is needed."""
    config = load_config()
    ws = config.workspace_path

    # Check if any provider has an API key configured (config or env var)
    import os
    has_provider_key = False
    from nanobot_web.providers.registry import PROVIDERS
    for spec in PROVIDERS:
        p = getattr(config.providers, spec.name, None)
        if p is None:
            continue
        if spec.is_oauth or spec.is_local:
            has_provider_key = True
            break
        if p.api_key or (spec.env_key and os.environ.get(spec.env_key)):
            has_provider_key = True
            break

    # Check if USER.md has been personalised (not just the template)
    user_md_path = ws / "USER.md"
    user_personalised = False
    if user_md_path.exists():
        content = user_md_path.read_text(encoding="utf-8")
        # Template has "(your name)" placeholder — if it's been replaced, it's personalised
        user_personalised = "(your name)" not in content

    needs_onboarding = not has_provider_key or not user_personalised
    return {
        "needs_onboarding": needs_onboarding,
        "has_provider_key": has_provider_key,
        "user_personalised": user_personalised,
    }


@app.get("/api/config")
def get_config():
    config_path = get_config_path()
    config = load_config()
    return {
        "configPath": str(config_path),
        "config": config.model_dump(by_alias=True),
    }


@app.post("/api/config/set")
def config_set(req: ConfigSetRequest):
    config = load_config()
    data = config.model_dump(by_alias=False)
    try:
        resolved = resolve_config_path(req.path)
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    set_path_value(data, resolved, req.value)
    try:
        config = Config.model_validate(data)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid config value: {exc}") from exc
    save_config(config)
    return {"ok": True}


@app.patch("/api/config")
def config_merge(req: ConfigMergeRequest):
    if not isinstance(req.patch, dict):
        raise HTTPException(status_code=400, detail="Patch must be a JSON object")
    config = load_config()
    data = config.model_dump(by_alias=True)
    deep_merge(data, req.patch)
    try:
        config = Config.model_validate(data)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid config patch: {exc}") from exc
    save_config(config)
    return {"ok": True}


@app.get("/api/tools")
def get_tools():
    return {
        "groups": TOOL_GROUPS,
    }


# Tool API key definitions — id, label, description, config path, env var fallback
API_KEY_TOOLS = [
    {
        "id": "brave",
        "label": "Brave Search",
        "description": "Web search via Brave Search API",
        "configPath": "tools.web.search.apiKey",
        "signupUrl": "https://brave.com/search/api/",
    },
    {
        "id": "serper",
        "label": "Serper (Google Search)",
        "description": "Google search results via Serper.dev",
        "configPath": "tools.serper.apiKey",
        "signupUrl": "https://serper.dev/",
    },
    {
        "id": "weather",
        "label": "OpenWeatherMap",
        "description": "Current weather data for any location",
        "configPath": "tools.weather.apiKey",
        "signupUrl": "https://openweathermap.org/api",
    },
    {
        "id": "news",
        "label": "NewsAPI",
        "description": "Top headlines and news search",
        "configPath": "tools.news.apiKey",
        "signupUrl": "https://newsapi.org/",
    },
    {
        "id": "wolfram",
        "label": "Wolfram Alpha",
        "description": "Math, science, and knowledge computations",
        "configPath": "tools.wolframAlpha.apiKey",
        "signupUrl": "https://developer.wolframalpha.com/",
    },
]


@app.get("/api/tools/api-keys")
def get_api_keys():
    """Return which API-key tools are configured (without exposing actual keys)."""
    config = load_config()
    result = []
    for tool in API_KEY_TOOLS:
        # Resolve config value to check if key exists
        key_val = ""
        try:
            parts = tool["configPath"].split(".")
            obj = config
            for p in parts:
                obj = getattr(obj, p.replace("A", "_a").replace("K", "_k") if p[0].islower() else p, obj)
            if isinstance(obj, str):
                key_val = obj
        except Exception:
            pass
        # Fallback: read from config dict
        if not key_val:
            data = config.model_dump(by_alias=True)
            try:
                obj = data
                for p in tool["configPath"].split("."):
                    obj = obj[p]
                if isinstance(obj, str):
                    key_val = obj
            except (KeyError, TypeError):
                pass
        result.append({
            **tool,
            "configured": bool(key_val),
            "maskedKey": key_val[:4] + "..." + key_val[-4:] if len(key_val) > 8 else ("***" if key_val else ""),
        })
    return {"tools": result}


@app.get("/api/integrations")
def get_integrations():
    import os
    config = load_config()
    api_key = config.tools.composio_api_key or os.environ.get("COMPOSIO_API_KEY", "")
    has_key = bool(api_key)
    connected = set()
    if has_key:
        try:
            toolset = _get_composio_toolset(config)
            accounts = toolset.get_connected_accounts()
            for acct in accounts:
                app_name = getattr(acct, "appUniqueId", None) or getattr(acct, "app_unique_id", None) or ""
                if app_name:
                    connected.add(app_name)
        except Exception:
            pass  # key may be invalid; still show UI with empty connected list
    return {
        "toolkits": INTEGRATION_TOOLKITS,
        "connected": sorted(connected),
        "hasApiKey": has_key,
        "maskedApiKey": f"{api_key[:4]}...{api_key[-4:]}" if len(api_key) > 8 else ("****" if api_key else ""),
    }


class IntegrationApiKeyRequest(BaseModel):
    api_key: str


@app.post("/api/integrations/api-key")
def set_integration_api_key(req: IntegrationApiKeyRequest):
    """Save the Composio API key to config."""
    config = load_config()
    data = config.model_dump(by_alias=True)
    deep_merge(data, {"tools": {"composioApiKey": req.api_key}})
    config = Config.model_validate(data)
    save_config(config)
    return {"ok": True}


@app.post("/api/integrations/connect")
def connect_integration(req: IntegrationConnectRequest):
    if req.toolkit not in {entry["id"] for entry in INTEGRATION_TOOLKITS}:
        raise HTTPException(status_code=400, detail="Unknown toolkit")
    toolset = _get_composio_toolset()
    # Check if already connected
    for acct in toolset.get_connected_accounts():
        app_name = getattr(acct, "appUniqueId", None) or getattr(acct, "app_unique_id", None) or ""
        if app_name == req.toolkit:
            return {"status": "connected", "toolkit": req.toolkit}
    # Initiate new connection
    conn_request = toolset.initiate_connection(app=req.toolkit)
    url = getattr(conn_request, "redirectUrl", None) or getattr(conn_request, "redirect_url", None)
    return {"status": "link", "toolkit": req.toolkit, "url": url}


@app.post("/api/integrations/disconnect")
def disconnect_integration(req: IntegrationDisconnectRequest):
    """Disconnect (delete) a Composio connected account for the given toolkit."""
    toolset = _get_composio_toolset()
    deleted = False
    for acct in toolset.get_connected_accounts():
        app_name = getattr(acct, "appUniqueId", None) or getattr(acct, "app_unique_id", None) or ""
        if app_name == req.toolkit:
            acct_id = getattr(acct, "id", None)
            if acct_id:
                try:
                    # Composio SDK: delete the connected account
                    toolset.client.connected_accounts.remove(id=acct_id)
                except AttributeError:
                    # Fallback: try alternative API paths
                    try:
                        toolset.client.http_client.delete(f"/v1/connectedAccounts/{acct_id}")
                    except Exception as exc:
                        raise HTTPException(
                            status_code=500,
                            detail=f"Failed to disconnect {req.toolkit}: {exc}",
                        ) from exc
            deleted = True
            break
    if not deleted:
        raise HTTPException(status_code=404, detail=f"{req.toolkit} is not connected")
    return {"status": "disconnected", "toolkit": req.toolkit}


@app.get("/api/cron/jobs")
def cron_jobs(include_disabled: bool = True, config_path: str | None = None):
    config = load_config(Path(config_path).expanduser().resolve()) if config_path else load_config()
    cron = CronService(_cron_store_path(config))
    jobs = cron.list_jobs(include_disabled=include_disabled)
    return {
        "jobs": [_cron_job_to_dict(job) for job in jobs],
        "status": cron.status(),
    }


@app.post("/api/cron/enable")
def cron_enable(req: CronJobEnableRequest, config_path: str | None = None):
    config = load_config(Path(config_path).expanduser().resolve()) if config_path else load_config()
    cron = CronService(_cron_store_path(config))
    job = cron.enable_job(req.job_id, req.enabled)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job": _cron_job_to_dict(job)}


@app.post("/api/cron/remove")
def cron_remove(req: CronJobRemoveRequest, config_path: str | None = None):
    config = load_config(Path(config_path).expanduser().resolve()) if config_path else load_config()
    cron = CronService(_cron_store_path(config))
    if not cron.remove_job(req.job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    return {"ok": True}


@app.post("/api/cron/create")
def cron_create(req: CronJobCreateRequest, config_path: str | None = None):
    from nanobot_web.cron.types import CronSchedule

    if not req.name.strip():
        raise HTTPException(status_code=400, detail="Job name is required")
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Message/prompt is required")

    config = load_config(Path(config_path).expanduser().resolve()) if config_path else load_config()
    global_tz = config.agents.defaults.timezone or None

    if req.schedule_kind == "every":
        if not req.every_minutes or req.every_minutes < 1:
            raise HTTPException(status_code=400, detail="Interval must be at least 1 minute")
        schedule = CronSchedule(kind="every", every_ms=req.every_minutes * 60 * 1000)
    elif req.schedule_kind == "cron":
        if not req.cron_expr or not req.cron_expr.strip():
            raise HTTPException(status_code=400, detail="Cron expression is required")
        # Fall back to global timezone if none specified per-job
        tz = req.cron_tz or global_tz or None
        schedule = CronSchedule(kind="cron", expr=req.cron_expr.strip(), tz=tz)
    elif req.schedule_kind == "at":
        if not req.at_datetime:
            raise HTTPException(status_code=400, detail="Date/time is required for one-shot jobs")
        try:
            from datetime import datetime, timezone as dt_tz
            dt = datetime.fromisoformat(req.at_datetime)
            if dt.tzinfo is None:
                # Use global timezone for naive datetimes, fall back to UTC
                if global_tz:
                    from zoneinfo import ZoneInfo
                    dt = dt.replace(tzinfo=ZoneInfo(global_tz))
                else:
                    dt = dt.replace(tzinfo=dt_tz.utc)
            at_ms = int(dt.timestamp() * 1000)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid datetime: {exc}") from exc
        schedule = CronSchedule(kind="at", at_ms=at_ms)
    else:
        raise HTTPException(status_code=400, detail="schedule_kind must be 'every', 'cron', or 'at'")

    cron = CronService(_cron_store_path(config))
    job = cron.add_job(
        name=req.name.strip(),
        schedule=schedule,
        message=req.message.strip(),
        deliver=req.deliver,
        channel=req.channel,
        to=req.to,
        delete_after_run=req.delete_after_run,
    )
    return {"job": _cron_job_to_dict(job)}


async def _deliver_to_channel(config: Config, channel_name: str, chat_id: str, content: str) -> None:
    """Directly send a message to a channel without needing a running ChannelManager."""
    from nanobot_web.bus.events import OutboundMessage
    from nanobot_web.channels.registry import discover_channel_names, load_channel_class

    channel_name = channel_name.lower()
    if channel_name not in discover_channel_names():
        raise ValueError(f"Channel '{channel_name}' does not exist")

    section = getattr(config.channels, channel_name, None)
    if not section or not getattr(section, "enabled", False):
        raise ValueError(f"Channel '{channel_name}' is not enabled in config")

    cls = load_channel_class(channel_name)
    bus = MessageBus()
    channel = cls(section, bus)
    channel.transcription_api_key = config.providers.groq.api_key

    # Initialize the channel for send-only use (builds bot/client without polling)
    await _init_channel_for_send(channel_name, channel)

    await channel.send(OutboundMessage(
        channel=channel_name,
        chat_id=chat_id,
        content=content,
    ))


async def _init_channel_for_send(channel_name: str, channel) -> None:
    """Initialize a channel just enough to send messages (no polling/listening)."""
    if channel_name == "telegram":
        from telegram.ext import Application
        from telegram.request import HTTPXRequest

        token = getattr(channel.config, "token", None)
        if not token:
            raise ValueError("Telegram bot token not configured")
        proxy = channel.config.proxy if channel.config.proxy else None
        req = HTTPXRequest(connect_timeout=30.0, read_timeout=30.0, proxy=proxy)
        channel._app = Application.builder().token(token).request(req).build()
        await channel._app.initialize()
    else:
        # For other channels, attempt a full start (most are lightweight)
        await channel.start()


def _make_direct_send(config: Config):
    """Create a direct-send callback that delivers messages to external channels.

    This bypasses the message bus (which needs a running ChannelManager) and
    instead initializes channel instances on-the-fly for send-only use.  Used by
    the web /api/chat endpoint and the /api/cron/run endpoint so that the agent
    can send to Telegram, Discord, Slack, etc. even when no gateway is running.
    """
    _send_channels: dict[str, Any] = {}  # cache initialized channel instances

    async def direct_send(msg):
        from nanobot_web.channels.registry import discover_channel_names, load_channel_class

        ch_name = msg.channel.lower()
        if ch_name not in discover_channel_names():
            return
        section = getattr(config.channels, ch_name, None)
        if not section or not getattr(section, "enabled", False):
            return

        # Reuse cached channel instance to avoid re-initializing on every send
        if ch_name not in _send_channels:
            cls = load_channel_class(ch_name)
            ch = cls(section, MessageBus())
            ch.transcription_api_key = config.providers.groq.api_key
            await _init_channel_for_send(ch_name, ch)
            _send_channels[ch_name] = ch

        await _send_channels[ch_name].send(msg)

    return direct_send


def _wire_direct_send(agent: AgentLoop, config: Config) -> None:
    """Wire direct cross-channel delivery into an agent's message tool."""
    message_tool = agent.tools.get("message")
    if message_tool:
        from nanobot_web.agent.tools.message import MessageTool
        if isinstance(message_tool, MessageTool):
            original_callback = message_tool._send_callback
            direct_send = _make_direct_send(config)

            async def smart_send(msg):
                """Route to direct channel send for external channels, bus for current."""
                if msg.channel.lower() not in ("web",):
                    await direct_send(msg)
                if original_callback:
                    await original_callback(msg)

            message_tool.set_send_callback(smart_send)


@app.post("/api/cron/run")
async def cron_run(req: CronJobRunRequest, config_path: str | None = None):
    config = load_config(Path(config_path).expanduser().resolve()) if config_path else load_config()
    cron = CronService(_cron_store_path(config))
    jobs = cron.list_jobs(include_disabled=True)
    job = next((item for item in jobs if item.id == req.job_id), None)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if not job.enabled and not req.force:
        raise HTTPException(status_code=400, detail="Job is disabled")

    agent = await _build_agent(config, cron)

    # Wire up direct channel delivery for the message tool
    direct_send = _make_direct_send(config)
    message_tool = agent.tools.get("message")
    if message_tool:
        from nanobot_web.agent.tools.message import MessageTool
        if isinstance(message_tool, MessageTool):
            message_tool.set_send_callback(direct_send)

    async def on_cron_job(target_job):
        from nanobot_web.agent.tools.cron import CronTool
        from nanobot_web.agent.tools.message import MessageTool as MT

        reminder_note = (
            "[Scheduled Task] Timer finished.\n\n"
            f"Task '{target_job.name}' has been triggered.\n"
            f"Scheduled instruction: {target_job.payload.message}"
        )

        job_channel = target_job.payload.channel or "web"
        job_chat_id = target_job.payload.to or f"cron:{target_job.id}"

        cron_tool = agent.tools.get("cron")
        cron_token = None
        if isinstance(cron_tool, CronTool):
            cron_token = cron_tool.set_cron_context(True)
        try:
            response = await agent.process_direct(
                reminder_note,
                session_key=f"cron:{target_job.id}",
                channel=job_channel,
                chat_id=job_chat_id,
            )
        finally:
            if isinstance(cron_tool, CronTool) and cron_token is not None:
                cron_tool.reset_cron_context(cron_token)

        # Wait for any spawned subagents to finish and process their results
        while agent.subagents.get_running_count() > 0:
            await asyncio.sleep(0.5)

        # Drain any inbound messages left by subagent announcements
        while True:
            try:
                sub_msg = await asyncio.wait_for(
                    agent.bus.consume_inbound(), timeout=0.2,
                )
            except asyncio.TimeoutError:
                break
            # Process the subagent result through the agent
            sub_response = await agent.process_direct(
                sub_msg.content,
                session_key=f"cron:{target_job.id}",
                channel=job_channel,
                chat_id=job_chat_id,
            )
            if sub_response:
                response = sub_response

        # Check if the message tool already delivered
        mt = agent.tools.get("message")
        if isinstance(mt, MT) and mt._sent_in_turn:
            return response

        # Deliver to channel if configured
        if target_job.payload.deliver and target_job.payload.to and response:
            channel_name = target_job.payload.channel
            if channel_name and channel_name != "web":
                try:
                    await _deliver_to_channel(
                        config, channel_name, target_job.payload.to, response,
                    )
                except Exception as exc:
                    from loguru import logger
                    logger.error("Cron delivery failed: {}", exc)
        return response

    cron.on_job = on_cron_job
    await cron.run_job(req.job_id, force=req.force)

    jobs = cron.list_jobs(include_disabled=True)
    updated = next((item for item in jobs if item.id == req.job_id), None)
    return {
        "job": _cron_job_to_dict(updated) if updated else None,
        "removed": updated is None,
    }


@app.post("/api/chat")
async def chat(req: ChatRequest):
    config_path = Path(req.config_path).expanduser().resolve() if req.config_path else None
    config = load_config(config_path)

    cron_store_path = _cron_store_path(config)
    cron_store_path.parent.mkdir(parents=True, exist_ok=True)
    cron = CronService(cron_store_path)

    agent = await _build_agent(config, cron, tools_enabled=req.tools_enabled)

    # Enable cross-channel delivery (e.g. send to Telegram from a web chat)
    _wire_direct_send(agent, config)

    async def event_stream():
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        done = asyncio.Event()

        async def on_progress(content: str, *, tool_hint: bool = False) -> None:
            await queue.put({
                "type": "tool_hint" if tool_hint else "progress",
                "content": content,
            })

        async def run_agent():
            try:
                response = await agent.process_direct(
                    req.message,
                    session_key=req.session_id,
                    channel="web",
                    chat_id=req.session_id,
                    on_progress=on_progress,
                )
                if response:
                    chunk_size = 64
                    for i in range(0, len(response), chunk_size):
                        await queue.put({
                            "type": "delta",
                            "content": response[i : i + chunk_size],
                        })
                await queue.put({"type": "done"})
            except Exception as exc:
                await queue.put({"type": "error", "content": str(exc)})
            finally:
                # Persist memory from this turn so new chats can recall it
                try:
                    session = await agent._get_session(req.session_id)
                    if session.messages and session.last_consolidated < len(session.messages):
                        await agent.memory_consolidator.archive_unconsolidated(session)
                        agent.sessions.save(session)
                except Exception:
                    pass
                done.set()
                await agent.close_mcp()

        task = asyncio.create_task(run_agent())
        try:
            while not done.is_set() or not queue.empty():
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=0.1)
                except asyncio.TimeoutError:
                    continue
                payload = json.dumps(item, ensure_ascii=True)
                yield f"data: {payload}\n\n"
        finally:
            task.cancel()

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# Knowledge section: system prompts (USER.md, SOUL.md) + file uploads
# ---------------------------------------------------------------------------

def _workspace(config: Config | None = None) -> Path:
    if config is None:
        config = load_config()
    return config.workspace_path


@app.get("/api/knowledge/prompts/{name}")
def get_prompt(name: str):
    if name not in ("USER", "SOUL", "AGENTS", "TOOLS"):
        raise HTTPException(status_code=400, detail="Unknown prompt name")

    ws = _workspace()
    path = ws / f"{name}.md"
    if not path.exists():
        tmpl = Path(__file__).parent.parent / "templates" / f"{name}.md"
        content = tmpl.read_text(encoding="utf-8") if tmpl.exists() else ""
    else:
        content = path.read_text(encoding="utf-8")
    return {"name": name, "content": content, "source": "workspace", "path": str(path)}


@app.put("/api/knowledge/prompts/{name}")
def save_prompt(name: str, req: PromptSaveRequest):
    if name not in ("USER", "SOUL", "AGENTS", "TOOLS"):
        raise HTTPException(status_code=400, detail="Unknown prompt name")

    ws = _workspace()
    path = ws / f"{name}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(req.content, encoding="utf-8")
    return {"ok": True, "source": "workspace"}


@app.get("/api/knowledge/files")
def list_knowledge_files():
    ws = _workspace()
    knowledge_dir = ws / "knowledge"
    if not knowledge_dir.exists():
        return {"files": []}
    files = []
    for f in sorted(knowledge_dir.iterdir()):
        if f.is_file():
            stat = f.stat()
            files.append({
                "name": f.name,
                "size": stat.st_size,
                "modifiedAt": int(stat.st_mtime * 1000),
            })
    return {"files": files}


@app.post("/api/knowledge/files")
async def upload_knowledge_file(file: UploadFile = File(...)):
    ws = _workspace()
    knowledge_dir = ws / "knowledge"
    knowledge_dir.mkdir(parents=True, exist_ok=True)

    # Check file count limit
    existing = [f for f in knowledge_dir.iterdir() if f.is_file()]
    if len(existing) >= MAX_KNOWLEDGE_FILES:
        raise HTTPException(
            status_code=400,
            detail=f"Maximum {MAX_KNOWLEDGE_FILES} knowledge files allowed",
        )

    # Read and validate size
    data = await file.read()
    if len(data) > MAX_KNOWLEDGE_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File exceeds 10 MB limit")

    # Sanitize filename
    filename = Path(file.filename).name if file.filename else f"upload-{uuid.uuid4().hex[:8]}"
    target = knowledge_dir / filename
    target.write_bytes(data)
    return {"ok": True, "name": filename, "size": len(data)}


@app.delete("/api/knowledge/files/{filename}")
def delete_knowledge_file(filename: str):
    ws = _workspace()
    target = ws / "knowledge" / filename
    # Prevent path traversal
    if not target.resolve().parent == (ws / "knowledge").resolve():
        raise HTTPException(status_code=400, detail="Invalid filename")
    if not target.exists():
        raise HTTPException(status_code=404, detail="File not found")
    target.unlink()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Memory section: list / read / delete memory entries
# ---------------------------------------------------------------------------

@app.get("/api/memory")
def list_memories():
    ws = _workspace()
    memory_dir = ws / "memory"
    if not memory_dir.exists():
        return {"entries": []}
    entries = []
    for f in sorted(memory_dir.iterdir()):
        if f.is_file() and f.suffix == ".md":
            stat = f.stat()
            content = f.read_text(encoding="utf-8")
            # Trim for preview (first 300 chars)
            preview = content[:300]
            entries.append({
                "filename": f.name,
                "preview": preview,
                "size": stat.st_size,
                "modifiedAt": int(stat.st_mtime * 1000),
            })
    return {"entries": entries}


@app.get("/api/memory/{filename}")
def read_memory(filename: str):
    ws = _workspace()
    target = ws / "memory" / filename
    if not target.resolve().parent == (ws / "memory").resolve():
        raise HTTPException(status_code=400, detail="Invalid filename")
    if not target.exists():
        raise HTTPException(status_code=404, detail="Memory not found")
    content = target.read_text(encoding="utf-8")
    return {"filename": filename, "content": content}


@app.delete("/api/memory/{filename}")
def delete_memory(filename: str):
    ws = _workspace()
    target = ws / "memory" / filename
    if not target.resolve().parent == (ws / "memory").resolve():
        raise HTTPException(status_code=400, detail="Invalid filename")
    if not target.exists():
        raise HTTPException(status_code=404, detail="Memory not found")
    target.unlink()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Skills section: list / read / add / delete skills
# ---------------------------------------------------------------------------

@app.get("/api/skills")
def list_skills():
    ws = _workspace()
    loader = SkillsLoader(ws)
    all_skills = loader.list_skills(filter_unavailable=False)
    result = []
    for s in all_skills:
        meta = loader.get_skill_metadata(s["name"]) or {}
        result.append({
            "name": s["name"],
            "source": s["source"],
            "description": meta.get("description", s["name"]),
            "available": loader._check_requirements(loader._get_skill_meta(s["name"])),
        })
    return {"skills": result}


@app.get("/api/skills/{name}")
def read_skill(name: str):
    ws = _workspace()
    loader = SkillsLoader(ws)
    content = loader.load_skill(name)
    if content is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    meta = loader.get_skill_metadata(name) or {}
    return {
        "name": name,
        "content": content,
        "description": meta.get("description", name),
    }


@app.post("/api/skills")
def create_skill(req: PromptSaveRequest, name: str = ""):
    if not name:
        raise HTTPException(status_code=400, detail="Skill name is required (query param ?name=...)")
    # Sanitize name
    safe_name = "".join(c for c in name if c.isalnum() or c in "-_").strip("-_")
    if not safe_name:
        raise HTTPException(status_code=400, detail="Invalid skill name")

    ws = _workspace()
    skill_dir = ws / "skills" / safe_name
    skill_dir.mkdir(parents=True, exist_ok=True)
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(req.content, encoding="utf-8")
    return {"ok": True, "name": safe_name}


@app.delete("/api/skills/{name}")
def delete_skill(name: str):
    ws = _workspace()
    skill_dir = ws / "skills" / name
    if not skill_dir.exists():
        raise HTTPException(status_code=404, detail="Skill not found")
    # Only allow deleting workspace skills, not builtins
    if not skill_dir.resolve().parent == (ws / "skills").resolve():
        raise HTTPException(status_code=400, detail="Invalid skill name")
    shutil.rmtree(skill_dir)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Serve frontend static files (SPA)
# ---------------------------------------------------------------------------

_FRONTEND_DIRS = [
    Path(__file__).parent.parent / "frontend" / "dist",  # installed package
    Path(__file__).parent.parent.parent / "frontend" / "dist",  # dev repo
    Path("/app/nanobot_web/frontend/dist"),  # Docker container
]


def _find_frontend_dir() -> Path | None:
    for d in _FRONTEND_DIRS:
        if d.is_dir() and (d / "index.html").exists():
            return d
    return None


_frontend = _find_frontend_dir()
if _frontend:
    from fastapi.responses import FileResponse
    from starlette.middleware.base import BaseHTTPMiddleware
    import mimetypes

    class _SPAMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            path = request.url.path
            if path.startswith(("/api", "/docs", "/redoc", "/openapi.json")):
                return await call_next(request)
            file_path = _frontend / path.lstrip("/")
            if path != "/" and file_path.is_file():
                media_type = mimetypes.guess_type(str(file_path))[0]
                return FileResponse(str(file_path), media_type=media_type)
            return FileResponse(str(_frontend / "index.html"), media_type="text/html")

    app.add_middleware(_SPAMiddleware)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("nanobot_web.web.server:app", host="127.0.0.1", port=18791, reload=False)
