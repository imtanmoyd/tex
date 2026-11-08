from __future__ import annotations

import pytest

from tex_engine.memory import (
    MemoryConflictError,
    MemoryStore,
    extract_fact_candidates,
)


@pytest.fixture
def store(tmp_path) -> MemoryStore:
    memory_store = MemoryStore(tmp_path / "memory.sqlite3")
    memory_store.initialize()
    return memory_store


def test_search_uses_local_keyword_relevance_and_prefers_current_site(
    store: MemoryStore,
) -> None:
    global_fact = store.create_memory("fact", "I prefer Python documentation.")
    other_note = store.create_memory(
        "site_note",
        "Python examples are available here.",
        site_host="other.example",
    )
    current_note = store.create_memory(
        "site_note",
        "Python reference examples for this site.",
        site_host="docs.python.org",
    )

    results = store.search("Python examples", site_host="docs.python.org")

    assert results[0]["id"] == current_note["id"]
    assert {item["id"] for item in results} == {
        global_fact["id"],
        other_note["id"],
        current_note["id"],
    }


def test_local_fact_extraction_is_limited_and_skips_sensitive_content() -> None:
    messages = [
        {"role": "assistant", "content": "I use Python for my projects."},
        {"role": "user", "content": "I live in Oslo and prefer Python."},
        {"role": "user", "content": "Please remember that my favorite editor is Vim."},
        {"role": "user", "content": "I use a password manager."},
    ]

    facts = extract_fact_candidates(messages)

    assert facts == [
        "I live in Oslo and prefer Python",
        "my favorite editor is Vim",
    ]


def test_completed_conversation_persists_chat_and_extracts_deduplicated_facts(
    store: MemoryStore,
) -> None:
    messages = [
        {"role": "user", "content": "I prefer Python tests."},
        {"role": "assistant", "content": "I can help with that."},
    ]

    assert store.save_conversation("chat-1", messages, "Use pytest.") == 1
    assert store.save_conversation("chat-1", messages, "Use pytest.") == 0

    exported = store.export()
    assert exported["chats"][0]["title"] == "I prefer Python tests."
    assert len(exported["chats"][0]["messages"]) == 3
    assert len(exported["facts"]) == 1
    assert store.recall_context("tests") is not None
    reopened = MemoryStore(store.path)
    reopened.initialize()
    assert reopened.search("Python")[0]["content"] == "I prefer Python tests"


def test_memory_crud_export_and_clear(store: MemoryStore) -> None:
    fact = store.create_memory("fact", "I like concise examples.")
    note = store.create_memory(
        "site_note",
        "The API examples are in this section.",
        site_host="docs.example",
    )

    updated = store.update_memory(fact["id"], content="I prefer concise examples.")
    assert updated is not None
    assert updated["content"] == "I prefer concise examples."
    assert store.get_memory(note["id"])["site_host"] == "docs.example"
    assert len(store.export()["siteNotes"]) == 1
    assert store.delete_memory(note["id"]) is True
    assert store.delete_memory(note["id"]) is False
    store.save_conversation(
        "chat-1",
        [{"role": "user", "content": "Hello"}],
        "Hi.",
    )

    store.clear()
    assert store.search() == []
    assert store.export()["facts"] == []
    assert store.export()["chats"] == []


def test_duplicate_manual_fact_is_reported(store: MemoryStore) -> None:
    store.create_memory("fact", "I prefer Python.")

    with pytest.raises(MemoryConflictError, match="already saved"):
        store.create_memory("fact", "  I prefer Python.  ")
