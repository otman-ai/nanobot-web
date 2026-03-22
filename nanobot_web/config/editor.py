"""Helpers for reading and editing nested config values safely."""

from __future__ import annotations

from typing import get_args, get_origin

from nanobot_web.config.schema import Config


def resolve_config_path(path: str) -> list[str]:
    """Resolve a dotted path to snake_case field names, validating schema."""
    parts = [p for p in path.split(".") if p]
    if not parts:
        raise ValueError("Empty config path")
    resolved: list[str] = []
    model_cls: type = Config
    for idx, part in enumerate(parts):
        name = _resolve_field_name(model_cls, part)
        if not name:
            raise KeyError(f"Unknown config field: {part}")
        resolved.append(name)
        if idx < len(parts) - 1:
            field = model_cls.model_fields[name]
            next_model = _model_from_annotation(field.annotation)
            if not next_model:
                raise TypeError(f"Cannot descend into non-object field: {part}")
            model_cls = next_model
    return resolved


def get_path_value(data: dict, path: list[str]):
    cur = data
    for part in path:
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def set_path_value(data: dict, path: list[str], value) -> None:
    cur = data
    for part in path[:-1]:
        if part not in cur or not isinstance(cur[part], dict):
            cur[part] = {}
        cur = cur[part]
    cur[path[-1]] = value


def deep_merge(dst: dict, src: dict) -> dict:
    for key, value in src.items():
        if isinstance(value, dict) and isinstance(dst.get(key), dict):
            deep_merge(dst[key], value)
        else:
            dst[key] = value
    return dst


def _resolve_field_name(model_cls: type, segment: str) -> str | None:
    if segment in getattr(model_cls, "model_fields", {}):
        return segment
    for name, field in getattr(model_cls, "model_fields", {}).items():
        alias = getattr(field, "alias", None)
        if alias == segment:
            return name
    return None


def _model_from_annotation(annotation) -> type | None:
    origin = get_origin(annotation)
    if origin is None:
        if isinstance(annotation, type) and hasattr(annotation, "model_fields"):
            return annotation
        return None
    if origin in (list, dict):
        return None
    for arg in get_args(annotation):
        if isinstance(arg, type) and hasattr(arg, "model_fields"):
            return arg
    return None
