"""Integration tools: let the agent manage and use external service integrations."""

import json
import os
from typing import Any

from loguru import logger

from nanobot_web.agent.tools.base import Tool


def _get_toolset():
    """Get a ComposioToolSet instance."""
    from composio import ComposioToolSet
    from nanobot_web.config.loader import load_config

    config = load_config()
    api_key = config.tools.composio_api_key or os.environ.get("COMPOSIO_API_KEY")
    if not api_key:
        raise RuntimeError("COMPOSIO_API_KEY not set — add it in Settings > Integrations")
    return ComposioToolSet(api_key=api_key)


class IntegrationsListTool(Tool):
    """List available integrations and their connection status."""

    name = "integrations_list"
    description = (
        "List available external integrations (Gmail, Google Calendar, Slack, GitHub, etc.) "
        "and show which ones are currently connected. Use this to check what's available "
        "before trying to use an integration."
    )
    parameters = {
        "type": "object",
        "properties": {},
    }

    async def execute(self, **kwargs: Any) -> str:
        try:
            toolset = _get_toolset()
            accounts = toolset.get_connected_accounts()
        except Exception as e:
            return json.dumps({"error": str(e)})

        connected = set()
        for acct in accounts:
            app_name = (
                getattr(acct, "appUniqueId", None)
                or getattr(acct, "app_unique_id", None)
                or ""
            )
            if app_name:
                connected.add(app_name.lower())

        toolkits = [
            {"id": "gmail", "name": "Gmail", "description": "Read, send, and manage email"},
            {"id": "googlecalendar", "name": "Google Calendar", "description": "View and create calendar events"},
            {"id": "googledrive", "name": "Google Drive", "description": "Access and manage files"},
            {"id": "outlook", "name": "Outlook", "description": "Email and calendar via Microsoft 365"},
            {"id": "notion", "name": "Notion", "description": "Read and update pages and databases"},
            {"id": "slack", "name": "Slack", "description": "Send and read messages"},
            {"id": "github", "name": "GitHub", "description": "Repos, issues, PRs, and actions"},
            {"id": "monday", "name": "Monday.com", "description": "Project and task management"},
            {"id": "shopify", "name": "Shopify", "description": "Manage your Shopify store"},
            {"id": "hubspot", "name": "HubSpot", "description": "CRM contacts, deals, and marketing"},
            {"id": "twitter", "name": "Twitter/X", "description": "Post tweets and read timeline"},
            {"id": "discord", "name": "Discord", "description": "Send messages and manage servers"},
            {"id": "trello", "name": "Trello", "description": "Boards, lists, and cards"},
            {"id": "jira", "name": "Jira", "description": "Issue tracking and project management"},
            {"id": "linear", "name": "Linear", "description": "Issue tracking and project management"},
            {"id": "airtable", "name": "Airtable", "description": "Databases and spreadsheets"},
        ]

        lines = ["Available integrations:\n"]
        for tk in toolkits:
            status = "CONNECTED" if tk["id"] in connected else "not connected"
            lines.append(f"- {tk['name']} ({tk['id']}): {tk['description']} [{status}]")

        standard_ids = {tk["id"] for tk in toolkits}
        extras = connected - standard_ids
        if extras:
            lines.append("\nOther connected accounts:")
            for e in sorted(extras):
                lines.append(f"- {e} [CONNECTED]")

        lines.append(
            "\nTo connect an integration, use the integrations_connect tool. "
            "To find actions, use integrations_actions with a query describing what you want to do."
        )
        return "\n".join(lines)


class IntegrationsConnectTool(Tool):
    """Initiate connection to an external integration."""

    name = "integrations_connect"
    description = (
        "Connect to an external service (e.g. Gmail, GitHub, Google Calendar). "
        "This starts an OAuth flow and returns a URL the user must open to authorize access. "
        "After authorization, the integration's tools become available."
    )
    parameters = {
        "type": "object",
        "properties": {
            "toolkit": {
                "type": "string",
                "description": "The toolkit ID to connect, e.g. 'gmail', 'googlecalendar', 'github', 'slack'",
            },
        },
        "required": ["toolkit"],
    }

    async def execute(self, toolkit: str, **kwargs: Any) -> str:
        toolkit = toolkit.lower().strip()

        try:
            toolset = _get_toolset()
        except Exception as e:
            return json.dumps({"error": str(e)})

        # Check if already connected
        for acct in toolset.get_connected_accounts():
            app_name = (
                getattr(acct, "appUniqueId", None)
                or getattr(acct, "app_unique_id", None)
                or ""
            )
            if app_name.lower() == toolkit:
                return f"{toolkit} is already connected. Use integrations_actions to see available actions."

        # Initiate new connection
        try:
            conn_request = toolset.initiate_connection(app=toolkit)
            url = (
                getattr(conn_request, "redirectUrl", None)
                or getattr(conn_request, "redirect_url", None)
            )
        except Exception as e:
            return f"Could not initiate connection for {toolkit}: {e}"

        if url:
            return (
                f"To connect {toolkit}, the user needs to open this URL to authorize access:\n\n"
                f"{url}\n\n"
                "After they authorize, the integration will be ready to use. "
                "Ask the user to let you know when they've completed authorization."
            )
        return f"Could not get authorization URL for {toolkit}. Make sure the toolkit ID is correct (use integrations_list to check available integrations)."


class IntegrationsActionsTool(Tool):
    """Search for available actions and get their parameter schemas."""

    name = "integrations_actions"
    description = (
        "Search for available actions on a connected integration. "
        "Returns action names with their descriptions and required parameters. "
        "Always use this before integrations_execute to find the correct action "
        "and know exactly what parameters to pass."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Describe what you want to do, e.g. 'send email gmail', 'read notion page', 'create github issue'",
            },
        },
        "required": ["query"],
    }

    async def execute(self, query: str, **kwargs: Any) -> str:
        try:
            toolset = _get_toolset()
            actions = toolset.find_actions_by_use_case(
                use_case=query.strip(),
            )
        except Exception as e:
            return json.dumps({"error": str(e)})

        if not actions:
            return f"No actions found for query '{query}'. Try a different search query or check integrations_list."

        lines = [f"Actions matching '{query}':\n"]
        for action in actions[:8]:
            name = getattr(action, "name", str(action))
            desc = getattr(action, "description", "")
            lines.append(f"## {name}")
            if desc:
                lines.append(f"Description: {desc}")

            params = getattr(action, "parameters", None) or getattr(action, "input_parameters", None)
            if params and isinstance(params, dict) and params.get("properties"):
                props = params["properties"]
                required = params.get("required", [])
                lines.append("Parameters:")
                for param_name, param_schema in props.items():
                    param_type = param_schema.get("type", "string")
                    param_desc = param_schema.get("description", "")
                    is_required = param_name in required
                    req_marker = " (REQUIRED)" if is_required else " (optional)"
                    lines.append(f"  - {param_name} ({param_type}{req_marker}): {param_desc}")
            lines.append("")

        lines.append("Use integrations_execute with the action name and the required params.")
        return "\n".join(lines)


class IntegrationsExecuteTool(Tool):
    """Execute an action on a connected integration."""

    name = "integrations_execute"
    description = (
        "Execute an action on a connected external service. For example, send an email via Gmail, "
        "create a GitHub issue, add a calendar event, etc. Use integrations_actions first to find "
        "the correct action and required parameters."
    )
    parameters = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "description": "The action to execute, e.g. 'GMAIL_SEND_EMAIL', 'GITHUB_CREATE_ISSUE'",
            },
            "params": {
                "type": "object",
                "description": "Parameters for the action as key-value pairs",
            },
        },
        "required": ["action"],
    }

    async def execute(self, action: str, params: dict | None = None, **kwargs: Any) -> str:
        # LLMs often pass action params as top-level kwargs instead of inside "params".
        merged = dict(params or {})
        merged.update(kwargs)

        try:
            toolset = _get_toolset()
            result = toolset.execute_action(
                action=action,
                params=merged,
            )
        except Exception as e:
            return f"Action {action} failed: {e}"

        if isinstance(result, dict):
            data = result.get("data", result)
            error_msg = result.get("error")
            if error_msg:
                return f"Action {action} failed: {error_msg}"
            successful = result.get("successful", False)
            if successful:
                return f"Action {action} completed successfully.\n\nResult:\n{json.dumps(data, indent=2)}"
            return f"Action {action} result:\n{json.dumps(data, indent=2)}"
        return f"Action {action} result:\n{json.dumps(result, indent=2)}"
