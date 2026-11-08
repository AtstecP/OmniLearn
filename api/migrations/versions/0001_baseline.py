"""Baseline: the schema as it existed before Alembic (global string IDs).

Every statement is idempotent, so this runs safely on a fresh database and on
an existing one that was created by the old schema.sql or by the API's former
startup `create_all()` + owner-column ALTER.

Revision ID: 0001
Revises:
Create Date: 2026-11-07
"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

STATEMENTS = [
    'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"',
    """CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email VARCHAR(320) NOT NULL UNIQUE,
        full_name VARCHAR(120) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS subjects (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        target_level VARCHAR(32),
        owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW())""",
    "ALTER TABLE subjects ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE",
    "CREATE INDEX IF NOT EXISTS idx_subject_owner ON subjects(owner_user_id)",
    """CREATE TABLE IF NOT EXISTS roadmap_nodes (
        id VARCHAR(64) PRIMARY KEY,
        subject_id VARCHAR(64) NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        parent_node_id VARCHAR(64) REFERENCES roadmap_nodes(id) ON DELETE SET NULL,
        title VARCHAR(255) NOT NULL,
        level VARCHAR(32),
        order_index INT DEFAULT 0,
        prerequisites TEXT[] DEFAULT '{}',
        content_markdown TEXT NOT NULL,
        test_ids TEXT[] DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS tests (
        id VARCHAR(64) PRIMARY KEY,
        subject_id VARCHAR(64) NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        node_id VARCHAR(64) REFERENCES roadmap_nodes(id) ON DELETE SET NULL,
        prompt TEXT NOT NULL,
        options JSONB NOT NULL,
        correct_index INT NOT NULL,
        explanation TEXT NOT NULL,
        tags TEXT[] DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS vocab_cards (
        id VARCHAR(64) PRIMARY KEY,
        subject_id VARCHAR(64) NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        term VARCHAR(255) NOT NULL,
        part_of_speech VARCHAR(64),
        definition TEXT NOT NULL,
        example_sentence TEXT,
        image_url VARCHAR(1024),
        audio_url VARCHAR(1024),
        tags TEXT[] DEFAULT '{}',
        source VARCHAR(64) DEFAULT 'manual',
        created_at TIMESTAMPTZ DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS user_vocab_progress (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        card_id VARCHAR(64) NOT NULL REFERENCES vocab_cards(id) ON DELETE CASCADE,
        user_id VARCHAR(64) NOT NULL,
        interval_days INT DEFAULT 1,
        ease_factor NUMERIC(4,2) DEFAULT 2.50,
        consecutive_correct INT DEFAULT 0,
        due_date TIMESTAMPTZ DEFAULT NOW(),
        last_reviewed_at TIMESTAMPTZ,
        status VARCHAR(32) DEFAULT 'learning',
        CONSTRAINT uq_user_card UNIQUE (user_id, card_id))""",
    """CREATE TABLE IF NOT EXISTS user_test_attempts (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        test_id VARCHAR(64) NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        user_id VARCHAR(64) NOT NULL,
        selected_index INT NOT NULL,
        is_correct BOOLEAN NOT NULL,
        is_flagged_mistake BOOLEAN DEFAULT FALSE,
        consecutive_correct_in_retest INT DEFAULT 0,
        attempted_at TIMESTAMPTZ DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS reading_passages (
        id VARCHAR(64) PRIMARY KEY,
        subject_id VARCHAR(64) NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        cefr_level VARCHAR(16),
        content TEXT NOT NULL,
        audio_url VARCHAR(1024),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS reading_questions (
        id VARCHAR(64) PRIMARY KEY,
        reading_id VARCHAR(64) NOT NULL REFERENCES reading_passages(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        options JSONB NOT NULL,
        correct_index INT NOT NULL,
        explanation TEXT NOT NULL,
        order_index INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW())""",
    """CREATE TABLE IF NOT EXISTS user_node_progress (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        node_id VARCHAR(64) NOT NULL REFERENCES roadmap_nodes(id) ON DELETE CASCADE,
        user_id VARCHAR(64) NOT NULL,
        status VARCHAR(32) DEFAULT 'in_progress',
        completed_at TIMESTAMPTZ,
        CONSTRAINT uq_user_node UNIQUE (user_id, node_id))""",
]


def upgrade():
    for statement in STATEMENTS:
        op.execute(statement)


def downgrade():
    raise NotImplementedError("The baseline cannot be downgraded; drop the database instead.")
