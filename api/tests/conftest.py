"""API tests run against a real PostgreSQL database (the schema uses arrays, gen_random_uuid()
and composite foreign keys, so SQLite would not do).

Set TEST_DATABASE_URL to a THROWAWAY database. The tests create accounts and subjects in it and
never clean up, and the suite refuses to run against anything that looks like a hosted database.

Locally:  docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t postgres:16-alpine
          TEST_DATABASE_URL=postgresql+psycopg://postgres:t@localhost:5433/t pytest
"""
import os
import uuid

import pytest

URL = os.environ.get("TEST_DATABASE_URL", "")
if not URL:
    pytest.exit("Set TEST_DATABASE_URL to a throwaway PostgreSQL database (see tests/conftest.py).", returncode=2)
if any(bad in URL for bad in ("neon.tech", "neon.build", "amazonaws.com", "supabase", "vercel")):
    pytest.exit("TEST_DATABASE_URL looks like a hosted database. Use a throwaway local one.", returncode=2)

# The app reads its settings at import time, so set them before importing it.
os.environ["DATABASE_URL"] = URL
os.environ["COOKIE_SECURE"] = "false"
os.environ["JWT_SECRET"] = "test-secret-" + "x" * 40

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

PASSWORD = "correct-horse-battery"
HERE = os.path.dirname(__file__)


@pytest.fixture(scope="session", autouse=True)
def schema():
    cfg = Config(os.path.join(HERE, "..", "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(HERE, "..", "migrations"))
    command.upgrade(cfg, "head")


@pytest.fixture(scope="session")
def app():
    from app.main import app as fastapi_app
    return fastapi_app


def new_client(app) -> TestClient:
    """A client signed in as a brand-new account (it has its own cookie jar)."""
    c = TestClient(app, base_url="http://testserver")
    r = c.post("/auth/register", json={"email": f"t{uuid.uuid4().hex[:12]}@test.dev", "full_name": "Tester", "password": PASSWORD})
    assert r.status_code == 201, r.text
    return c


@pytest.fixture()
def alice(app):
    return new_client(app)


@pytest.fixture()
def bob(app):
    return new_client(app)


def q(prompt: str, n: int = 2, answer: int = 0):
    return {"question": prompt, "options": [f"option {i}" for i in range(n)], "answer": answer, "explanation": "because"}


BUNDLE = {
    "title": "French basics",
    "description": "test course",
    "lessons": [
        {"title": "Greetings", "content": "# Greetings\n\nBonjour means hello. unicorn", "level": "A1",
         "questions": [q("Q1"), q("Q2")],
         "lessons": [{"title": "Formal", "content": "Vous", "questions": [q("Q3")], "lessons": []},
                     {"title": "Informal", "content": "Tu", "questions": [], "lessons": []}]},
        {"title": "Food", "content": "Le pain", "questions": [q("Q4")], "lessons": []},
    ],
    "questions": [q("Loose question")],
    "vocabulary": [
        {"term": "bonjour", "definition": "hello", "tags": ["greetings"]},
        {"term": "merci", "definition": "thanks", "tags": ["greetings"]},
        {"term": "pain", "definition": "bread", "tags": ["food"]},
        {"term": "eau", "definition": "water"},
    ],
    "readings": [{"title": "At the cafe", "content": "Un café, s'il vous plaît. " * 20, "level": "A1",
                  "questions": [q("R1"), q("R2")]}],
    "phrases": [
        {"answer": "Bonjour, comment allez-vous ?", "translation": "Hello, how are you?", "tags": ["greetings"]},
        {"answer": "Je voudrais du pain.", "translation": "I would like bread.", "tags": ["food"]},
        {"answer": "Merci beaucoup.", "translation": "Thank you very much."},
    ],
}


def import_subject(client, bundle=None) -> str:
    r = client.post("/subjects/import", json=bundle or BUNDLE)
    assert r.status_code in (200, 201), r.text
    return r.json()["subject_id"]


@pytest.fixture()
def course(alice):
    return alice, import_subject(alice)
