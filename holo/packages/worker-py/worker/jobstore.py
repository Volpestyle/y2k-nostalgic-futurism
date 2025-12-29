from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Optional

from .types import Job


class JobStore:
    def __init__(self, db_path: Path):
        self.db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def claim_next_queued_job(self) -> Optional[Job]:
        # Simple "claim" via transaction: select oldest queued, mark running.
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC LIMIT 1",
                ("queued",),
            ).fetchone()
            if row is None:
                conn.execute("COMMIT")
                return None
            job_id = row["id"]
            now_ms = int(time.time() * 1000)
            conn.execute(
                "UPDATE jobs SET status = ?, updated_at = ?, progress = ? WHERE id = ?",
                ("running", now_ms, 0.01, job_id),
            )
            conn.execute("COMMIT")
            return Job(
                id=row["id"],
                created_at_ms=row["created_at"],
                updated_at_ms=now_ms,
                status="running",
                progress=0.01,
                input_key=row["input_key"],
                spec_json=row["spec_json"],
                output_key=row["output_key"] or "",
                error_message=row["error_message"] or "",
            )

    def update(self, job_id: str, *, status: Optional[str] = None, progress: Optional[float] = None,
               output_key: Optional[str] = None, error_message: Optional[str] = None) -> None:
        with self._connect() as conn:
            now_ms = int(time.time() * 1000)
            # Use COALESCE-like behavior in Python to keep SQL simple.
            current = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if current is None:
                return
            conn.execute(
                "UPDATE jobs SET updated_at=?, status=?, progress=?, output_key=?, error_message=? WHERE id=?",
                (
                    now_ms,
                    status if status is not None else current["status"],
                    progress if progress is not None else current["progress"],
                    output_key if output_key is not None else current["output_key"],
                    error_message if error_message is not None else current["error_message"],
                    job_id,
                ),
            )
