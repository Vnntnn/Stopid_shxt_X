"""SQLite persistence for election projects, imported policy data and model runs."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("ONFLY_PROJECT_DB", ROOT / ".runtime" / "projects.sqlite3"))


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


@contextmanager
def session():
    db = connect()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db():
    with session() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          election TEXT NOT NULL,
          year TEXT NOT NULL DEFAULT '',
          location TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS policies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          party TEXT NOT NULL DEFAULT '',
          candidate TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          source_kind TEXT NOT NULL,
          source_url TEXT NOT NULL DEFAULT '',
          source_label TEXT NOT NULL DEFAULT '',
          source_meta TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS policies_project_idx ON policies(project_id);
        CREATE TABLE IF NOT EXISTS comparisons (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          policy_a_id INTEGER NOT NULL REFERENCES policies(id),
          policy_b_id INTEGER NOT NULL REFERENCES policies(id),
          criterion TEXT NOT NULL,
          situation TEXT NOT NULL DEFAULT '',
          winner_id INTEGER REFERENCES policies(id),
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS comparisons_project_idx ON comparisons(project_id);
        """)


def _policy(row):
    item = dict(row)
    item["source_meta"] = json.loads(item.pop("source_meta", "{}"))
    return item


def list_projects():
    with session() as db:
        rows = db.execute("""SELECT p.*, COUNT(d.id) AS policy_count
          FROM projects p LEFT JOIN policies d ON d.project_id=p.id
          GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC""").fetchall()
        return [dict(row) for row in rows]


def create_project(name, election, year="", location=""):
    with session() as db:
        cur = db.execute("INSERT INTO projects(name,election,year,location,created_at) VALUES(?,?,?,?,?)",
                         (name, election, year, location, now()))
        project_id = cur.lastrowid
    return get_project(project_id)


def get_project(project_id):
    with session() as db:
        row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        return dict(row) if row else None


def save_policies(project_id, items):
    created = now()
    with session() as db:
        if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            return None
        ids = []
        for item in items:
            cur = db.execute("""INSERT INTO policies
              (project_id,title,party,candidate,category,content,source_kind,source_url,source_label,source_meta,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
              (project_id, item["title"], item.get("party", ""), item.get("candidate", ""),
               item.get("category", ""), item.get("content", ""), item["source_kind"],
               item.get("source_url", ""), item.get("source_label", ""),
               json.dumps(item.get("source_meta", {}), ensure_ascii=False), created))
            ids.append(cur.lastrowid)
        return ids


def list_policies(project_id):
    with session() as db:
        rows = db.execute("SELECT * FROM policies WHERE project_id=? ORDER BY id DESC", (project_id,)).fetchall()
        return [_policy(row) for row in rows]


def get_policy(project_id, policy_id):
    with session() as db:
        row = db.execute("SELECT * FROM policies WHERE project_id=? AND id=?", (project_id, policy_id)).fetchone()
        return _policy(row) if row else None


def save_comparison(project_id, policy_a_id, policy_b_id, criterion, situation, winner_id, response):
    with session() as db:
        cur = db.execute("""INSERT INTO comparisons
          (project_id,policy_a_id,policy_b_id,criterion,situation,winner_id,response_json,created_at)
          VALUES(?,?,?,?,?,?,?,?)""",
          (project_id, policy_a_id, policy_b_id, criterion, situation, winner_id,
           json.dumps(response, ensure_ascii=False), now()))
        return cur.lastrowid


def _comparison(row):
    item = dict(row)
    item["response"] = json.loads(item.pop("response_json"))
    return item


def summary(project_id):
    project = get_project(project_id)
    if not project:
        return None
    policies = list_policies(project_id)
    with session() as db:
        rows = db.execute("""SELECT c.*, a.title AS policy_a_title, b.title AS policy_b_title,
          a.party AS policy_a_party, b.party AS policy_b_party
          FROM comparisons c JOIN policies a ON a.id=c.policy_a_id JOIN policies b ON b.id=c.policy_b_id
          WHERE c.project_id=? ORDER BY c.created_at DESC, c.id DESC""", (project_id,)).fetchall()
    decisions = [_comparison(row) for row in rows]
    return {
        "project": project,
        "policy_count": len(policies),
        "categories": dict(Counter(p["category"] or "ไม่ระบุหมวดหมู่" for p in policies)),
        "sources": dict(Counter(p["source_label"] or p["source_kind"] for p in policies)),
        "decisions": decisions,
    }
