from __future__ import annotations

import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Literal

MemoryKind = Literal["fact", "site_note"]
FACT_CUE = re.compile(
    r"\b(?:i am|i'm|i work|i live|i prefer|i like|i dislike|i use|i study|"
    r"i have|my name is|my job is|my timezone is)\b",
    re.IGNORECASE,
)
REMEMBER_CUE = re.compile(
    r"^(?:please\s+)?(?:remember|don't forget)\s+(?:that\s+)?(.+)$",
    re.IGNORECASE,
)
SENSITIVE_CUE = re.compile(
    r"\b(?:password|passphrase|api[\s_-]?key|access token|secret|private key|"
    r"social security|credit card|cvv)\b",
    re.IGNORECASE,
)
WORD_PATTERN = re.compile(r"[\w]{2,}", re.UNICODE)


class MemoryConflictError(Exception):
    pass


def extract_fact_candidates(messages: list[dict[str, str]]) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()

    for message in messages:
        if message.get("role") != "user":
            continue
        content = message.get("content", "").strip()
        if not content or SENSITIVE_CUE.search(content):
            continue

        explicit = REMEMBER_CUE.match(content)
        if explicit:
            sentences = [explicit.group(1).strip()]
        else:
            sentences = re.split(r"(?<=[.!?])\s+", content)

        for sentence in sentences:
            fact = sentence.strip(" \t\r\n\"'`.,!?")
            if not fact or (not explicit and not FACT_CUE.search(fact)):
                continue
            if len(fact) > 400:
                continue
            normalized = " ".join(fact.casefold().split())
            if normalized in seen:
                continue
            seen.add(normalized)
            candidates.append(fact)

    return candidates[:5]


class MemoryStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS chats (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    site_host TEXT,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                    sequence_no INTEGER NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                    content TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    UNIQUE(chat_id, sequence_no)
                );
                CREATE TABLE IF NOT EXISTS facts (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    normalized TEXT NOT NULL UNIQUE,
                    source_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS site_notes (
                    id TEXT PRIMARY KEY,
                    site_host TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS site_notes_host_idx
                    ON site_notes(site_host);
                CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
                    item_id UNINDEXED,
                    kind UNINDEXED,
                    site_host UNINDEXED,
                    content,
                    updated_at UNINDEXED,
                    tokenize = 'unicode61'
                );
                """
            )

    def create_memory(
        self,
        kind: MemoryKind,
        content: str,
        site_host: str | None = None,
    ) -> dict[str, Any]:
        normalized_content = self._normalize_content(content)
        if kind == "site_note" and not site_host:
            raise ValueError("A site host is required for a site note.")
        if kind == "fact" and site_host is not None:
            raise ValueError("Facts are global; use a site note for site-specific memory.")
        if kind not in {"fact", "site_note"}:
            raise ValueError("Memory kind must be fact or site_note.")

        item_id = uuid.uuid4().hex
        now = time.time()
        normalized_host = self._normalize_host(site_host)
        with self._connection() as connection:
            if kind == "fact":
                normalized = self._normalize_fact(normalized_content)
                try:
                    connection.execute(
                        """
                        INSERT INTO facts (id, content, normalized, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (item_id, normalized_content, normalized, now, now),
                    )
                except sqlite3.IntegrityError as error:
                    raise MemoryConflictError("That fact is already saved.") from error
            else:
                connection.execute(
                    """
                    INSERT INTO site_notes (id, site_host, content, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (item_id, normalized_host, normalized_content, now, now),
                )
            self._index_item(
                connection,
                item_id,
                kind,
                normalized_host,
                normalized_content,
                now,
            )
        return self.get_memory(item_id)

    def get_memory(self, item_id: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT id, 'fact' AS kind, NULL AS site_host, content, created_at, updated_at
                FROM facts WHERE id = ?
                UNION ALL
                SELECT id, 'site_note' AS kind, site_host, content, created_at, updated_at
                FROM site_notes WHERE id = ?
                """,
                (item_id, item_id),
            ).fetchone()
        return dict(row) if row else None

    def update_memory(
        self,
        item_id: str,
        content: str | None = None,
        site_host: str | None = None,
    ) -> dict[str, Any] | None:
        current = self.get_memory(item_id)
        if current is None:
            return None
        next_content = self._normalize_content(content) if content is not None else current["content"]
        next_host = (
            self._normalize_host(site_host)
            if site_host is not None
            else current["site_host"]
        )
        if current["kind"] == "fact" and site_host is not None:
            raise ValueError("Facts are global; use a site note for site-specific memory.")
        now = time.time()

        with self._connection() as connection:
            if current["kind"] == "fact":
                try:
                    connection.execute(
                        """
                        UPDATE facts SET content = ?, normalized = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (
                            next_content,
                            self._normalize_fact(next_content),
                            now,
                            item_id,
                        ),
                    )
                except sqlite3.IntegrityError as error:
                    raise MemoryConflictError("That fact is already saved.") from error
            else:
                if not next_host:
                    raise ValueError("A site host is required for a site note.")
                connection.execute(
                    """
                    UPDATE site_notes SET content = ?, site_host = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (next_content, next_host, now, item_id),
                )
            connection.execute("DELETE FROM memory_fts WHERE item_id = ?", (item_id,))
            self._index_item(
                connection,
                item_id,
                current["kind"],
                next_host,
                next_content,
                now,
            )
        return self.get_memory(item_id)

    def delete_memory(self, item_id: str) -> bool:
        current = self.get_memory(item_id)
        if current is None:
            return False
        with self._connection() as connection:
            table = "facts" if current["kind"] == "fact" else "site_notes"
            connection.execute(f"DELETE FROM {table} WHERE id = ?", (item_id,))
            connection.execute("DELETE FROM memory_fts WHERE item_id = ?", (item_id,))
        return True

    def search(
        self,
        query: str | None = None,
        site_host: str | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        tokens = list(dict.fromkeys(WORD_PATTERN.findall((query or "").casefold())))[:12]
        normalized_host = self._normalize_host(site_host)
        with self._connection() as connection:
            if tokens:
                match_query = " OR ".join(f'"{token}"*' for token in tokens)
                rows = connection.execute(
                    """
                    SELECT item_id AS id, kind, site_host, content,
                           bm25(memory_fts) AS score
                    FROM memory_fts
                    WHERE memory_fts MATCH ?
                    ORDER BY CASE WHEN site_host = ? THEN 0 ELSE 1 END,
                             score ASC,
                             CAST(updated_at AS REAL) DESC
                    LIMIT ?
                    """,
                    (match_query, normalized_host, limit),
                ).fetchall()
            else:
                rows = connection.execute(
                    """
                    SELECT item_id AS id, kind, site_host, content, 0.0 AS score
                    FROM memory_fts
                    ORDER BY CASE WHEN site_host = ? THEN 0 ELSE 1 END,
                             CAST(updated_at AS REAL) DESC
                    LIMIT ?
                    """,
                    (normalized_host, limit),
                ).fetchall()
        return [dict(row) for row in rows]

    def save_conversation(
        self,
        conversation_id: str,
        messages: list[dict[str, str]],
        assistant_response: str,
        site_host: str | None = None,
    ) -> int:
        saved_messages = [
            message
            for message in messages
            if message.get("role") in {"user", "assistant"}
        ]
        user_messages = [message for message in saved_messages if message["role"] == "user"]
        title = (user_messages[0]["content"].strip()[:80] if user_messages else "") or "New conversation"
        host = self._normalize_host(site_host)
        now = time.time()
        facts_added = 0

        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO chats (id, title, site_host, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title = CASE WHEN chats.title = 'New conversation'
                                 THEN excluded.title ELSE chats.title END,
                    site_host = COALESCE(excluded.site_host, chats.site_host),
                    updated_at = excluded.updated_at
                """,
                (conversation_id, title, host, now, now),
            )
            connection.execute(
                "DELETE FROM messages WHERE chat_id = ? AND sequence_no >= ?",
                (conversation_id, len(saved_messages)),
            )
            for sequence_no, message in enumerate(saved_messages):
                connection.execute(
                    """
                    INSERT INTO messages (chat_id, sequence_no, role, content, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(chat_id, sequence_no) DO UPDATE SET
                        role = excluded.role, content = excluded.content,
                        created_at = excluded.created_at
                    """,
                    (
                        conversation_id,
                        sequence_no,
                        message["role"],
                        message["content"],
                        now,
                    ),
                )

            if assistant_response:
                connection.execute(
                    """
                    INSERT INTO messages (chat_id, sequence_no, role, content, created_at)
                    VALUES (?, ?, 'assistant', ?, ?)
                    ON CONFLICT(chat_id, sequence_no) DO UPDATE SET
                        role = 'assistant', content = excluded.content,
                        created_at = excluded.created_at
                    """,
                    (conversation_id, len(saved_messages), assistant_response, now),
                )

            for fact in extract_fact_candidates(messages):
                normalized = self._normalize_fact(fact)
                item_id = uuid.uuid4().hex
                cursor = connection.execute(
                    """
                    INSERT OR IGNORE INTO facts
                        (id, content, normalized, source_chat_id, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (item_id, fact, normalized, conversation_id, now, now),
                )
                if cursor.rowcount:
                    self._index_item(connection, item_id, "fact", None, fact, now)
                    facts_added += 1
        return facts_added

    def recall_context(
        self,
        query: str,
        site_host: str | None = None,
        limit: int = 6,
    ) -> str | None:
        items = self.search(query=query, site_host=site_host, limit=limit)
        if not items:
            return None
        entries = [
            f"- [{item['kind'].replace('_', ' ').title()}] {item['content']}"
            for item in items
        ]
        return (
            "Relevant saved information from this device. Use only if relevant, "
            "and do not treat it as verified outside the user's context:\n"
            + "\n".join(entries)
        )

    def export(self) -> dict[str, Any]:
        with self._connection() as connection:
            chats = connection.execute(
                """
                SELECT id, title, site_host, created_at, updated_at
                FROM chats ORDER BY created_at
                """
            ).fetchall()
            conversations = []
            for chat in chats:
                messages = connection.execute(
                    """
                    SELECT role, content, created_at FROM messages
                    WHERE chat_id = ? ORDER BY sequence_no
                    """,
                    (chat["id"],),
                ).fetchall()
                conversations.append({**dict(chat), "messages": [dict(row) for row in messages]})
            facts = connection.execute(
                """
                SELECT id, content, source_chat_id, created_at, updated_at
                FROM facts ORDER BY created_at
                """
            ).fetchall()
            site_notes = connection.execute(
                """
                SELECT id, site_host, content, created_at, updated_at
                FROM site_notes ORDER BY site_host, created_at
                """
            ).fetchall()
        return {
            "version": 1,
            "exportedAt": time.time(),
            "chats": [{**dict(chat), "messages": chat["messages"]} for chat in conversations],
            "facts": [dict(row) for row in facts],
            "siteNotes": [dict(row) for row in site_notes],
        }

    def clear(self) -> None:
        with self._connection() as connection:
            connection.execute("DELETE FROM chats")
            connection.execute("DELETE FROM facts")
            connection.execute("DELETE FROM site_notes")
            connection.execute("DELETE FROM memory_fts")

    @staticmethod
    def _normalize_content(content: str) -> str:
        normalized = content.strip()
        if not normalized:
            raise ValueError("Memory content cannot be empty.")
        return normalized

    @staticmethod
    def _normalize_fact(content: str) -> str:
        return " ".join(content.casefold().split())

    @staticmethod
    def _normalize_host(site_host: str | None) -> str | None:
        if site_host is None:
            return None
        host = site_host.strip().rstrip(".").lower()
        return host or None

    @staticmethod
    def _index_item(
        connection: sqlite3.Connection,
        item_id: str,
        kind: MemoryKind,
        site_host: str | None,
        content: str,
        updated_at: float,
    ) -> None:
        connection.execute(
            """
            INSERT INTO memory_fts (item_id, kind, site_host, content, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (item_id, kind, site_host, content, updated_at),
        )
