from __future__ import annotations

import base64
import json
import mimetypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

import httpx


def guess_mime(path: Path) -> str:
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def to_data_uri(data: bytes, mime: str) -> str:
    b64 = base64.b64encode(data).decode("utf-8")
    return f"data:{mime};base64,{b64}"


@dataclass
class ArtifactStore:
    out_dir: Path

    def __post_init__(self) -> None:
        self.out_dir.mkdir(parents=True, exist_ok=True)

    def path(self, *parts: str) -> Path:
        p = self.out_dir.joinpath(*parts)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def write_bytes(self, relpath: str, data: bytes) -> Path:
        p = self.path(relpath)
        p.write_bytes(data)
        return p

    def write_text(self, relpath: str, text: str) -> Path:
        p = self.path(relpath)
        p.write_text(text, encoding="utf-8")
        return p

    def write_json(self, relpath: str, obj: Any, *, indent: int = 2) -> Path:
        p = self.path(relpath)
        p.write_text(json.dumps(obj, indent=indent, ensure_ascii=False) + "\n", encoding="utf-8")
        return p

    def download(self, url: str, relpath: str, *, timeout_s: float = 120.0) -> Path:
        p = self.path(relpath)
        with httpx.stream("GET", url, timeout=timeout_s, follow_redirects=True) as r:
            r.raise_for_status()
            with p.open("wb") as f:
                for chunk in r.iter_bytes():
                    f.write(chunk)
        return p

    def file_to_data_uri(self, path: Path) -> str:
        data = path.read_bytes()
        mime = guess_mime(path)
        return to_data_uri(data, mime)

    def maybe_save_http_file(self, output: Any, relpath: str) -> Path:
        """Save a Replicate/Meshy file output.

        - If `output` is a file-like object with .read(), we read it.
        - If it's a URL string, we download it.
        """
        p = self.path(relpath)

        # Replicate FileOutput implements .read()
        if hasattr(output, "read") and callable(getattr(output, "read")):
            data = output.read()
            if isinstance(data, str):
                data = data.encode("utf-8")
            if not isinstance(data, (bytes, bytearray)):
                raise TypeError(f"Expected bytes from .read(), got {type(data)}")
            p.write_bytes(bytes(data))
            return p

        if isinstance(output, str) and output.startswith(("http://", "https://")):
            return self.download(output, relpath)

        raise TypeError(f"Unsupported output type for file save: {type(output)}")

    def as_posix(self, p: Path) -> str:
        return p.resolve().as_posix()
