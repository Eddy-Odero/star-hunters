"""Startup-configurable structured logging for Star Hunters backend services."""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import UTC, datetime
from typing import Any

ROOT_LOGGER_NAME = "star_hunters"
VALID_LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
UNIFIED_THIRD_PARTY_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access", "astropy")


class JsonLogFormatter(logging.Formatter):
    """Emit structured JSON log records suitable for Fly.io / cloud log pipelines."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        event_name = getattr(record, "event", None)
        if event_name:
            payload["event"] = event_name
        context = getattr(record, "context", None)
        if isinstance(context, dict) and context:
            payload["context"] = context
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def parse_log_level(raw_level: str | None) -> tuple[int, str, bool]:
    """Parse ``LOG_LEVEL`` string into `(numeric_level, normalized_name, used_fallback)`."""
    candidate = (raw_level or "INFO").strip().upper()
    if candidate in VALID_LOG_LEVELS:
        return getattr(logging, candidate), candidate, False
    return logging.INFO, "INFO", True


def configure_backend_logging(
    level: str | None = None,
    log_format: str | None = None,
) -> logging.Logger:
    """Configure the ``star_hunters`` logger hierarchy from arguments or environment."""
    raw_level = level if level is not None else os.environ.get("LOG_LEVEL", "INFO")
    raw_format = (
        (log_format if log_format is not None else os.environ.get("LOG_FORMAT", "text"))
        .strip()
        .lower()
    )
    numeric_level, normalized_level, used_fallback = parse_log_level(raw_level)

    logger = logging.getLogger(ROOT_LOGGER_NAME)
    logger.setLevel(numeric_level)

    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.set_name("star_hunters_stdout")
        logger.addHandler(handler)

    formatter: logging.Formatter
    if raw_format == "json":
        formatter = JsonLogFormatter()
    else:
        formatter = logging.Formatter(
            fmt="%(asctime)s %(levelname)s [%(name)s] %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )

    for handler in logger.handlers:
        handler.setLevel(numeric_level)
        handler.setFormatter(formatter)

    # Unify third-party runtime loggers (Uvicorn, Astropy) onto the same format and tag
    # records with their package/logger name without causing duplicate propagation.
    for third_party_name in UNIFIED_THIRD_PARTY_LOGGERS:
        third_party_logger = logging.getLogger(third_party_name)
        third_party_level = (
            max(numeric_level, logging.WARNING) if third_party_name == "astropy" else numeric_level
        )
        third_party_logger.setLevel(third_party_level)
        third_party_logger.propagate = False
        unified_handler_name = f"star_hunters_unified_{third_party_name}"
        existing = [
            h
            for h in third_party_logger.handlers
            if getattr(h, "name", None) == unified_handler_name
        ]
        if existing and len(third_party_logger.handlers) == 1:
            handler = existing[0]
        else:
            third_party_logger.handlers.clear()
            handler = logging.StreamHandler(sys.stdout)
            handler.set_name(unified_handler_name)
            third_party_logger.addHandler(handler)
        handler.setLevel(third_party_level)
        handler.setFormatter(formatter)

    # Keep Uvicorn / root logger quiet unless higher severity, while allowing pytest caplog capture.
    if used_fallback and raw_level:
        logger.warning(
            "Invalid LOG_LEVEL=%r provided on startup; defaulting to %s",
            raw_level,
            normalized_level,
        )
    return logger


def get_logger(component: str) -> logging.Logger:
    """Return a child logger under ``star_hunters.<component>``."""
    clean = component.strip().removeprefix("app.").removeprefix(f"{ROOT_LOGGER_NAME}.")
    return logging.getLogger(f"{ROOT_LOGGER_NAME}.{clean}")
