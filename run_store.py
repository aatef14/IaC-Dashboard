"""
SQLite-backed persistence for run history (init/fmt/validate/plan/apply).

Runs themselves stay live in run_manager's in-memory dict while active
(subscriber queues for SSE streaming can't be serialized), but every run is
write-through persisted here so history survives a server restart. On
startup, run_manager loads everything back via load_all_runs() and
rehydrates plain (non-streamable, already-finished) Run objects from it.
"""

import json
import os
import sqlite3
import threading

DB_FILE = os.path.join(os.path.dirname(__file__), "runs.db")

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_FILE, check_same_thread=False)
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY,
                project_id TEXT,
                kind TEXT,
                name TEXT,
                is_destroy INTEGER,
                status TEXT,
                target_json TEXT,
                summary_json TEXT,
                log TEXT,
                plan_file TEXT,
                related_plan_run_id TEXT,
                created_at REAL,
                finished_at REAL
            )
            """
        )
        _conn.commit()
    return _conn


def save_run(run) -> None:
    """Upsert the current state of a Run (called on creation and again on
    close -- an in-progress run persisted mid-flight and never updated
    again just means the server died; load_all_runs() below reconciles that
    into an honest 'failed' status rather than leaving it stuck 'running'
    forever)."""
    conn = _get_conn()
    with _lock:
        conn.execute(
            """
            INSERT INTO runs (run_id, project_id, kind, name, is_destroy, status,
                               target_json, summary_json, log, plan_file,
                               related_plan_run_id, created_at, finished_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                status=excluded.status,
                summary_json=excluded.summary_json,
                log=excluded.log,
                plan_file=excluded.plan_file,
                finished_at=excluded.finished_at
            """,
            (
                run.id,
                run.target.get("project_id"),
                run.kind,
                run.name,
                1 if run.is_destroy else 0,
                run.status,
                json.dumps(run.target),
                json.dumps(run.summary) if run.summary is not None else None,
                "\n".join(run.lines),
                run.plan_file,
                run.related_plan_run_id,
                run.created_at,
                run.finished_at,
            ),
        )
        conn.commit()


def load_all_runs() -> list[dict]:
    """Return every persisted run as a plain dict (caller reconstructs Run
    objects with it). Any run still marked 'running' is a leftover from a
    server process that died mid-run -- there's no way to actually recover
    it, so it's surfaced with status forced to 'failed' plus a note, not
    silently left looking like it's still going."""
    conn = _get_conn()
    with _lock:
        rows = conn.execute(
            """
            SELECT run_id, project_id, kind, name, is_destroy, status, target_json,
                   summary_json, log, plan_file, related_plan_run_id, created_at, finished_at
            FROM runs ORDER BY created_at ASC
            """
        ).fetchall()

    results = []
    for row in rows:
        (
            run_id, project_id, kind, name, is_destroy, status, target_json,
            summary_json, log, plan_file, related_plan_run_id, created_at, finished_at,
        ) = row
        lines = log.split("\n") if log else []
        if status == "running":
            status = "failed"
            lines.append("[dashboard restarted while this run was in progress -- treating as failed]")
            finished_at = finished_at or created_at

        results.append(
            {
                "run_id": run_id,
                "project_id": project_id,
                "kind": kind,
                "name": name,
                "is_destroy": bool(is_destroy),
                "status": status,
                "target": json.loads(target_json) if target_json else {},
                "summary": json.loads(summary_json) if summary_json else None,
                "lines": lines,
                "plan_file": plan_file,
                "related_plan_run_id": related_plan_run_id,
                "created_at": created_at,
                "finished_at": finished_at,
            }
        )
    return results


def delete_runs_for_project(project_id: str) -> None:
    conn = _get_conn()
    with _lock:
        conn.execute("DELETE FROM runs WHERE project_id = ?", (project_id,))
        conn.commit()
