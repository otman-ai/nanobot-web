"""Interactive onboarding wizard for nanobot-web CLI."""

import getpass
from dataclasses import dataclass, field
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.table import Table


@dataclass
class WizardResult:
    """Collects all wizard answers."""

    # User profile (→ USER.md)
    name: str = ""
    timezone: str = ""
    language: str = "English"
    communication_style: str = ""
    response_length: str = ""
    technical_level: str = ""
    primary_role: str = ""
    main_projects: str = ""
    tools_used: str = ""
    special_instructions: str = ""
    # Config updates (→ config.json)
    provider_name: str = ""
    provider_api_key: str = ""
    model: str = ""
    brave_api_key: str = ""
    composio_api_key: str = ""
    channels: dict = field(default_factory=dict)
    skipped: bool = False


# Curated list of popular providers for the wizard
WIZARD_PROVIDERS = [
    ("anthropic", "Anthropic (Claude)", "anthropic/claude-sonnet-4-20250514"),
    ("openai", "OpenAI (GPT)", "openai/gpt-4o"),
    ("deepseek", "DeepSeek", "deepseek/deepseek-chat"),
    ("gemini", "Google Gemini", "gemini/gemini-2.0-flash"),
    ("openrouter", "OpenRouter (multi-provider)", "openrouter/anthropic/claude-sonnet-4"),
    ("ollama", "Ollama (local)", "ollama/llama3.2"),
]

CHANNEL_LIST = [
    ("telegram", "Telegram", [("token", "Bot token", False)]),
    ("discord", "Discord", [("token", "Bot token", False)]),
    ("slack", "Slack", [("bot_token", "Bot token", False), ("app_token", "App token", False)]),
    ("whatsapp", "WhatsApp", [("bridge_url", "Bridge URL", False)]),
]


def _prompt(console: Console, label: str, default: str = "", secret: bool = False) -> str:
    """Prompt user for input. Returns default if empty."""
    suffix = f" [{default}]" if default else ""
    try:
        if secret:
            value = getpass.getpass(f"  {label}{suffix}: ")
        else:
            value = input(f"  {label}{suffix}: ")
    except (EOFError, KeyboardInterrupt):
        console.print()
        return default
    return value.strip() or default


def _prompt_choice(console: Console, label: str, choices: list[str], default: str = "") -> str:
    """Show numbered choices and return selected value."""
    console.print(f"  {label}:")
    for i, choice in enumerate(choices, 1):
        marker = " *" if choice == default else ""
        console.print(f"    [dim]{i}.[/dim] {choice}{marker}")
    raw = _prompt(console, "Choice (number or Enter to skip)", default="")
    if not raw:
        return default
    try:
        idx = int(raw) - 1
        if 0 <= idx < len(choices):
            return choices[idx]
    except ValueError:
        # Treat raw text as direct value
        if raw in choices:
            return raw
    return default


def _step_user_profile(console: Console) -> dict:
    """Step 1: About You."""
    console.print("\n[bold cyan]Step 1/6: About You[/bold cyan]")
    console.print("[dim]Press Enter to skip any field.[/dim]\n")
    name = _prompt(console, "Your name")
    timezone = _prompt(console, "Timezone (e.g. America/New_York, Asia/Shanghai)")
    language = _prompt(console, "Preferred language", default="English")
    return {"name": name, "timezone": timezone, "language": language}


def _step_work_context(console: Console) -> dict:
    """Step 2: Work Context."""
    console.print("\n[bold cyan]Step 2/6: Work Context[/bold cyan]")
    console.print("[dim]Press Enter to skip any field.[/dim]\n")
    comm = _prompt_choice(console, "Communication style", ["Casual", "Professional", "Technical"])
    length = _prompt_choice(
        console, "Response length", ["Brief and concise", "Detailed explanations", "Adaptive"]
    )
    level = _prompt_choice(console, "Technical level", ["Beginner", "Intermediate", "Expert"])
    role = _prompt(console, "Primary role (e.g. developer, researcher)")
    projects = _prompt(console, "Main projects you're working on")
    tools = _prompt(console, "Tools you use (IDEs, languages, frameworks)")
    special = _prompt(console, "Special instructions for the assistant")
    return {
        "communication_style": comm,
        "response_length": length,
        "technical_level": level,
        "primary_role": role,
        "main_projects": projects,
        "tools_used": tools,
        "special_instructions": special,
    }


def _step_provider(console: Console) -> dict:
    """Step 3: LLM Provider."""
    console.print("\n[bold cyan]Step 3/6: LLM Provider[/bold cyan]")
    console.print("[dim]Choose your AI provider. Press Enter to skip.[/dim]\n")

    for i, (_, label, default_model) in enumerate(WIZARD_PROVIDERS, 1):
        console.print(f"    [dim]{i}.[/dim] {label}  [dim]({default_model})[/dim]")

    raw = _prompt(console, "Choice (number)")
    if not raw:
        return {}

    try:
        idx = int(raw) - 1
        if not (0 <= idx < len(WIZARD_PROVIDERS)):
            return {}
    except ValueError:
        return {}

    name, label, default_model = WIZARD_PROVIDERS[idx]
    model = _prompt(console, "Model", default=default_model)

    api_key = ""
    if name != "ollama":
        api_key = _prompt(console, "API key", secret=True)

    return {"provider_name": name, "provider_api_key": api_key, "model": model}


def _step_channels(console: Console) -> dict:
    """Step 4: Chat Channels."""
    console.print("\n[bold cyan]Step 4/6: Chat Channels[/bold cyan]")
    console.print("[dim]Enter numbers to enable (e.g. 1,3). Press Enter to skip.[/dim]\n")

    for i, (_, label, _fields) in enumerate(CHANNEL_LIST, 1):
        console.print(f"    [dim]{i}.[/dim] {label}")

    raw = _prompt(console, "Channels to enable")
    if not raw:
        return {}

    channels = {}
    selected = set()
    for part in raw.replace(",", " ").split():
        try:
            idx = int(part) - 1
            if 0 <= idx < len(CHANNEL_LIST):
                selected.add(idx)
        except ValueError:
            pass

    for idx in sorted(selected):
        ch_id, ch_label, fields = CHANNEL_LIST[idx]
        console.print(f"\n  [bold]{ch_label}[/bold] configuration:")
        ch_data = {"enabled": True}
        for field_name, field_label, is_secret in fields:
            ch_data[field_name] = _prompt(console, field_label, secret=is_secret)
        channels[ch_id] = ch_data

    return channels


def _step_tools(console: Console) -> dict:
    """Step 5: Tool Integrations."""
    console.print("\n[bold cyan]Step 5/6: Tool Integrations[/bold cyan]")
    console.print("[dim]Press Enter to skip.[/dim]\n")
    brave_key = _prompt(console, "Brave Search API key (for web search)", secret=True)
    return {"brave_api_key": brave_key}


def _step_composio(console: Console) -> dict:
    """Step 6: Composio Integration."""
    console.print("\n[bold cyan]Step 6/6: Composio Integration[/bold cyan]")
    console.print("[dim]Composio connects 250+ apps (Gmail, GitHub, Slack, Notion, etc.)[/dim]")
    console.print("[dim]Get your API key at https://app.composio.dev — Press Enter to skip.[/dim]\n")
    api_key = _prompt(console, "Composio API key", secret=True)
    return {"composio_api_key": api_key}


def _print_summary(console: Console, result: WizardResult) -> None:
    """Print a summary panel of all configured values."""
    table = Table(show_header=False, box=None, padding=(0, 2))
    table.add_column("Field", style="dim")
    table.add_column("Value")

    if result.name:
        table.add_row("Name", result.name)
    if result.timezone:
        table.add_row("Timezone", result.timezone)
    if result.language != "English":
        table.add_row("Language", result.language)
    if result.communication_style:
        table.add_row("Style", result.communication_style)
    if result.technical_level:
        table.add_row("Level", result.technical_level)
    if result.primary_role:
        table.add_row("Role", result.primary_role)
    if result.provider_name:
        table.add_row("Provider", result.provider_name)
    if result.model:
        table.add_row("Model", result.model)
    if result.provider_api_key:
        table.add_row("API Key", result.provider_api_key[:8] + "..." if len(result.provider_api_key) > 8 else "***")
    if result.channels:
        table.add_row("Channels", ", ".join(result.channels.keys()))
    if result.brave_api_key:
        table.add_row("Brave Search", "configured")
    if result.composio_api_key:
        table.add_row("Composio", "configured")

    console.print()
    console.print(Panel(table, title="Setup Summary", border_style="green"))


def generate_user_md(result: WizardResult) -> str:
    """Generate USER.md content from wizard results."""
    def _check(value: str, option: str) -> str:
        return "[x]" if value == option else "[ ]"

    lines = [
        "# User Profile",
        "",
        "Information about the user to help personalize interactions.",
        "",
        "## Basic Information",
        "",
        f"- **Name**: {result.name or '(your name)'}",
        f"- **Timezone**: {result.timezone or '(your timezone)'}",
        f"- **Language**: {result.language or 'English'}",
        "",
        "## Preferences",
        "",
        "### Communication Style",
        "",
        f"- {_check(result.communication_style, 'Casual')} Casual",
        f"- {_check(result.communication_style, 'Professional')} Professional",
        f"- {_check(result.communication_style, 'Technical')} Technical",
        "",
        "### Response Length",
        "",
        f"- {_check(result.response_length, 'Brief and concise')} Brief and concise",
        f"- {_check(result.response_length, 'Detailed explanations')} Detailed explanations",
        f"- {_check(result.response_length, 'Adaptive')} Adaptive based on question",
        "",
        "### Technical Level",
        "",
        f"- {_check(result.technical_level, 'Beginner')} Beginner",
        f"- {_check(result.technical_level, 'Intermediate')} Intermediate",
        f"- {_check(result.technical_level, 'Expert')} Expert",
        "",
        "## Work Context",
        "",
        f"- **Primary Role**: {result.primary_role or '(your role)'}",
        f"- **Main Projects**: {result.main_projects or '(your projects)'}",
        f"- **Tools You Use**: {result.tools_used or '(your tools)'}",
        "",
        "## Special Instructions",
        "",
        result.special_instructions or "(Any specific instructions for how the assistant should behave)",
        "",
        "---",
        "",
        "*Edit this file to customize nanobot-web's behavior for your needs.*",
        "",
    ]
    return "\n".join(lines)


def apply_wizard_to_config(config, result: WizardResult):
    """Apply wizard results to a Config object and return it."""
    if result.model:
        config.agents.defaults.model = result.model

    if result.timezone:
        config.agents.defaults.timezone = result.timezone

    if result.provider_name and result.provider_api_key:
        provider_cfg = getattr(config.providers, result.provider_name, None)
        if provider_cfg is not None:
            provider_cfg.api_key = result.provider_api_key

    if result.brave_api_key:
        config.tools.web.search.api_key = result.brave_api_key

    if result.composio_api_key:
        config.tools.composio_api_key = result.composio_api_key

    for ch_name, ch_data in result.channels.items():
        ch_cfg = getattr(config.channels, ch_name, None)
        if ch_cfg is None:
            continue
        for key, value in ch_data.items():
            if hasattr(ch_cfg, key):
                setattr(ch_cfg, key, value)

    return config


def run_wizard(config, workspace: Path, console: Console) -> WizardResult:
    """Run the interactive onboarding wizard. Returns WizardResult."""
    console.print("\n[bold cyan]Welcome to the nanobot-web Setup Wizard![/bold cyan]")
    console.print("[dim]This will help you configure your personal AI assistant.[/dim]")
    console.print("[dim]Press Enter to skip any step or field.\n[/dim]")

    result = WizardResult()

    try:
        # Step 1: About You
        profile = _step_user_profile(console)
        result.name = profile.get("name", "")
        result.timezone = profile.get("timezone", "")
        result.language = profile.get("language", "English")

        # Step 2: Work Context
        work = _step_work_context(console)
        result.communication_style = work.get("communication_style", "")
        result.response_length = work.get("response_length", "")
        result.technical_level = work.get("technical_level", "")
        result.primary_role = work.get("primary_role", "")
        result.main_projects = work.get("main_projects", "")
        result.tools_used = work.get("tools_used", "")
        result.special_instructions = work.get("special_instructions", "")

        # Step 3: LLM Provider
        provider = _step_provider(console)
        result.provider_name = provider.get("provider_name", "")
        result.provider_api_key = provider.get("provider_api_key", "")
        result.model = provider.get("model", "")

        # Step 4: Chat Channels
        result.channels = _step_channels(console)

        # Step 5: Tool Integrations
        tools = _step_tools(console)
        result.brave_api_key = tools.get("brave_api_key", "")

        # Step 6: Composio Integration
        composio = _step_composio(console)
        result.composio_api_key = composio.get("composio_api_key", "")

    except KeyboardInterrupt:
        console.print("\n[yellow]Wizard interrupted. Saving what was entered so far.[/yellow]")

    _print_summary(console, result)
    return result
