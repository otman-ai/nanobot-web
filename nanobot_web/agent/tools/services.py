"""API-key-based service tools: Serper, OpenWeatherMap, NewsAPI, Wolfram Alpha."""

import json
import os
from typing import Any

import httpx
from loguru import logger

from nanobot_web.agent.tools.base import Tool


class SerperSearchTool(Tool):
    """Search Google via Serper.dev API."""

    name = "google_search"
    description = "Search Google for web results. Returns titles, URLs, and snippets."
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query"},
            "count": {"type": "integer", "description": "Number of results (1-10)", "minimum": 1, "maximum": 10},
        },
        "required": ["query"],
    }

    def __init__(self, api_key: str | None = None, proxy: str | None = None):
        self._init_api_key = api_key
        self.proxy = proxy

    @property
    def api_key(self) -> str:
        return self._init_api_key or os.environ.get("SERPER_API_KEY", "")

    async def execute(self, query: str, count: int | None = None, **kwargs: Any) -> str:
        if not self.api_key:
            return (
                "Error: Serper API key not configured. Set it in "
                "~/.nanobot-web/config.json under tools.serper.apiKey "
                "(or export SERPER_API_KEY)."
            )
        try:
            n = min(max(count or 5, 1), 10)
            async with httpx.AsyncClient(proxy=self.proxy) as client:
                r = await client.post(
                    "https://google.serper.dev/search",
                    json={"q": query, "num": n},
                    headers={"X-API-KEY": self.api_key, "Content-Type": "application/json"},
                    timeout=10.0,
                )
                r.raise_for_status()

            data = r.json()
            results = data.get("organic", [])[:n]
            if not results:
                return f"No results for: {query}"

            lines = [f"Google results for: {query}\n"]
            for i, item in enumerate(results, 1):
                lines.append(f"{i}. {item.get('title', '')}\n   {item.get('link', '')}")
                if snippet := item.get("snippet"):
                    lines.append(f"   {snippet}")
            return "\n".join(lines)
        except Exception as e:
            logger.error("SerperSearch error: {}", e)
            return f"Error: {e}"


class WeatherTool(Tool):
    """Get current weather using OpenWeatherMap API."""

    name = "weather"
    description = "Get current weather for a location. Returns temperature, conditions, humidity, and wind."
    parameters = {
        "type": "object",
        "properties": {
            "location": {"type": "string", "description": "City name, e.g. 'London' or 'Tokyo,JP'"},
            "units": {
                "type": "string",
                "enum": ["metric", "imperial"],
                "description": "Temperature units (metric=Celsius, imperial=Fahrenheit)",
            },
        },
        "required": ["location"],
    }

    def __init__(self, api_key: str | None = None, proxy: str | None = None):
        self._init_api_key = api_key
        self.proxy = proxy

    @property
    def api_key(self) -> str:
        return self._init_api_key or os.environ.get("OPENWEATHERMAP_API_KEY", "")

    async def execute(self, location: str, units: str = "metric", **kwargs: Any) -> str:
        if not self.api_key:
            return (
                "Error: OpenWeatherMap API key not configured. Set it in "
                "~/.nanobot-web/config.json under tools.weather.apiKey "
                "(or export OPENWEATHERMAP_API_KEY). Get a free key at openweathermap.org"
            )
        try:
            unit_label = "°C" if units == "metric" else "°F"
            speed_label = "m/s" if units == "metric" else "mph"
            async with httpx.AsyncClient(proxy=self.proxy) as client:
                r = await client.get(
                    "https://api.openweathermap.org/data/2.5/weather",
                    params={"q": location, "units": units, "appid": self.api_key},
                    timeout=10.0,
                )
                r.raise_for_status()

            d = r.json()
            weather = d.get("weather", [{}])[0]
            main = d.get("main", {})
            wind = d.get("wind", {})
            name = d.get("name", location)
            country = d.get("sys", {}).get("country", "")

            return (
                f"Weather in {name}, {country}:\n"
                f"  Condition: {weather.get('main', '?')} — {weather.get('description', '')}\n"
                f"  Temperature: {main.get('temp', '?')}{unit_label} "
                f"(feels like {main.get('feels_like', '?')}{unit_label})\n"
                f"  Humidity: {main.get('humidity', '?')}%\n"
                f"  Wind: {wind.get('speed', '?')} {speed_label}\n"
                f"  Pressure: {main.get('pressure', '?')} hPa"
            )
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                return f"Location not found: {location}"
            logger.error("Weather API error: {}", e)
            return f"Error: {e}"
        except Exception as e:
            logger.error("Weather error: {}", e)
            return f"Error: {e}"


class NewsTool(Tool):
    """Get top news headlines using NewsAPI."""

    name = "news"
    description = "Get top news headlines, optionally filtered by topic or country."
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search topic (optional, omit for top headlines)"},
            "country": {
                "type": "string",
                "description": "2-letter country code, e.g. 'us', 'gb', 'de' (default: us)",
            },
            "count": {"type": "integer", "description": "Number of articles (1-10)", "minimum": 1, "maximum": 10},
        },
    }

    def __init__(self, api_key: str | None = None, proxy: str | None = None):
        self._init_api_key = api_key
        self.proxy = proxy

    @property
    def api_key(self) -> str:
        return self._init_api_key or os.environ.get("NEWSAPI_KEY", "")

    async def execute(self, query: str | None = None, country: str = "us", count: int | None = None, **kwargs: Any) -> str:
        if not self.api_key:
            return (
                "Error: NewsAPI key not configured. Set it in "
                "~/.nanobot-web/config.json under tools.news.apiKey "
                "(or export NEWSAPI_KEY). Get a free key at newsapi.org"
            )
        try:
            n = min(max(count or 5, 1), 10)
            params: dict[str, Any] = {"apiKey": self.api_key, "pageSize": n}
            if query:
                url = "https://newsapi.org/v2/everything"
                params["q"] = query
                params["sortBy"] = "publishedAt"
            else:
                url = "https://newsapi.org/v2/top-headlines"
                params["country"] = country

            async with httpx.AsyncClient(proxy=self.proxy) as client:
                r = await client.get(url, params=params, timeout=10.0)
                r.raise_for_status()

            articles = r.json().get("articles", [])[:n]
            if not articles:
                return f"No news found{' for: ' + query if query else ''}."

            header = f"News{' about ' + query if query else ' headlines (' + country.upper() + ')'}:\n"
            lines = [header]
            for i, a in enumerate(articles, 1):
                source = a.get("source", {}).get("name", "")
                lines.append(f"{i}. {a.get('title', '')}")
                if source:
                    lines.append(f"   Source: {source}")
                if desc := a.get("description"):
                    lines.append(f"   {desc}")
                if url := a.get("url"):
                    lines.append(f"   {url}")
            return "\n".join(lines)
        except Exception as e:
            logger.error("NewsAPI error: {}", e)
            return f"Error: {e}"


class WolframAlphaTool(Tool):
    """Query Wolfram Alpha for computations and knowledge."""

    name = "wolfram_alpha"
    description = "Ask Wolfram Alpha for math, science, conversions, facts, and computations."
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Question or computation, e.g. 'integrate x^2 dx' or 'population of France'"},
        },
        "required": ["query"],
    }

    def __init__(self, api_key: str | None = None, proxy: str | None = None):
        self._init_api_key = api_key
        self.proxy = proxy

    @property
    def api_key(self) -> str:
        return self._init_api_key or os.environ.get("WOLFRAM_APP_ID", "")

    async def execute(self, query: str, **kwargs: Any) -> str:
        if not self.api_key:
            return (
                "Error: Wolfram Alpha App ID not configured. Set it in "
                "~/.nanobot-web/config.json under tools.wolframAlpha.apiKey "
                "(or export WOLFRAM_APP_ID). Get one at developer.wolframalpha.com"
            )
        try:
            async with httpx.AsyncClient(proxy=self.proxy) as client:
                # Use the Full Results API for structured data
                r = await client.get(
                    "https://api.wolframalpha.com/v2/query",
                    params={"input": query, "appid": self.api_key, "output": "json", "format": "plaintext"},
                    timeout=15.0,
                )
                r.raise_for_status()

            data = r.json().get("queryresult", {})
            if not data.get("success"):
                tips = data.get("tips", {}).get("text", "")
                return f"Wolfram Alpha couldn't interpret: {query}" + (f"\nTip: {tips}" if tips else "")

            pods = data.get("pods", [])
            if not pods:
                return f"No results for: {query}"

            lines = []
            for pod in pods[:6]:
                title = pod.get("title", "")
                subpods = pod.get("subpods", [])
                texts = [sp.get("plaintext", "") for sp in subpods if sp.get("plaintext")]
                if texts:
                    lines.append(f"**{title}**")
                    for t in texts:
                        lines.append(f"  {t}")
                    lines.append("")
            return "\n".join(lines).strip() or f"No displayable results for: {query}"
        except Exception as e:
            logger.error("WolframAlpha error: {}", e)
            return f"Error: {e}"
