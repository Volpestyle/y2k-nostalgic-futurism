from __future__ import annotations

import logging
from typing import Optional

from rich.console import Console
from rich.logging import RichHandler

_DEFAULT_LOGGER_NAME = "img2mesh3d"


def get_console() -> Console:
    return Console()


def setup_logging(level: str = "INFO", logger_name: str = _DEFAULT_LOGGER_NAME) -> logging.Logger:
    """Configure a Rich logger (idempotent)."""
    logger = logging.getLogger(logger_name)
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))

    # Avoid adding duplicate handlers if called multiple times.
    if not any(isinstance(h, RichHandler) for h in logger.handlers):
        handler = RichHandler(rich_tracebacks=True)
        handler.setLevel(getattr(logging, level.upper(), logging.INFO))
        fmt = logging.Formatter("%(message)s", datefmt="[%X]")
        handler.setFormatter(fmt)
        logger.addHandler(handler)

    logger.propagate = False
    return logger


def get_logger(name: Optional[str] = None) -> logging.Logger:
    return logging.getLogger(name or _DEFAULT_LOGGER_NAME)
