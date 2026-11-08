"""Scope learning-content IDs to their subject.

Primary keys change from (id) to (subject_id, id) for roadmap nodes, tests,
vocabulary cards and reading passages; reading questions become
(subject_id, reading_id, id). Progress and attempt tables gain a subject_id
column and composite foreign keys. Existing IDs are kept unchanged, including
older browser-prefixed ones such as "u1a2b3c4d_lesson_1".

Requires PostgreSQL 15+ for ON DELETE SET NULL (column).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-07
"""
from alembic import op
from sqlalchemy import text

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

CONTENT_TABLES = ("roadmap_nodes", "tests", "vocab_cards", "reading_passages", "reading_questions")
CHILD_TABLES = {
    # table: (parent table, column holding the parent's id)
    "reading_questions": ("reading_passages", "reading_id"),
    "user_node_progress": ("roadmap_nodes", "node_id"),
    "user_vocab_progress": ("vocab_cards", "card_id"),
    "user_test_attempts": ("tests", "test_id"),
}
# Single-column indexes made redundant by the new composite keys. Both the old
# schema.sql names (idx_*) and SQLAlchemy create_all names (ix_*) are covered.
OBSOLETE_INDEXES = (
    "idx_roadmap_subject", "ix_roadmap_nodes_subject_id", "idx_roadmap_parent",
    "idx_tests_subject", "ix_tests_subject_id", "idx_tests_node", "ix_tests_node_id",
    "idx_vocab_subject", "ix_vocab_cards_subject_id",
    "idx_readings_subject", "ix_reading_passages_subject_id",
    "idx_reading_questions_parent", "ix_reading_questions_reading_id",
    "idx_attempts_test", "ix_user_test_attempts_test_id",
)


def constraint_names(table: str, kind: str, referenced: tuple[str, ...] | None = None) -> list[str]:
    sql = "SELECT conname FROM pg_constraint WHERE conrelid = CAST(:t AS regclass) AND contype = :k"
    params = {"t": table, "k": kind}
    if referenced:
        sql += " AND confrelid::regclass::text = ANY(:r)"
        params["r"] = list(referenced)
    return list(op.get_bind().execute(text(sql), params).scalars())


def upgrade():
    # 1. Drop every foreign key that points at a content table's old primary key.
    for table in ("roadmap_nodes", "tests", *CHILD_TABLES):
        for name in constraint_names(table, "f", CONTENT_TABLES):
            op.execute(f'ALTER TABLE {table} DROP CONSTRAINT "{name}"')

    # 2. Give child tables a subject_id copied from their parent row.
    for table, (parent, column) in CHILD_TABLES.items():
        op.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS subject_id VARCHAR(64)")
        op.execute(f"UPDATE {table} c SET subject_id = p.subject_id FROM {parent} p WHERE p.id = c.{column} AND c.subject_id IS NULL")
        op.execute(f"DELETE FROM {table} WHERE subject_id IS NULL")  # orphans with no parent row
        op.execute(f"ALTER TABLE {table} ALTER COLUMN subject_id SET NOT NULL")

    # 3. Swap primary keys to composite ones.
    new_keys = {
        "roadmap_nodes": "subject_id, id",
        "tests": "subject_id, id",
        "vocab_cards": "subject_id, id",
        "reading_passages": "subject_id, id",
        "reading_questions": "subject_id, reading_id, id",
    }
    for table, columns in new_keys.items():
        for name in constraint_names(table, "p"):
            op.execute(f'ALTER TABLE {table} DROP CONSTRAINT "{name}"')
        op.execute(f"ALTER TABLE {table} ADD CONSTRAINT {table}_pkey PRIMARY KEY ({columns})")

    # 4. Clear links that point outside their own subject, then add composite foreign keys.
    op.execute("""UPDATE roadmap_nodes c SET parent_node_id = NULL WHERE parent_node_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM roadmap_nodes p WHERE p.subject_id = c.subject_id AND p.id = c.parent_node_id)""")
    op.execute("""UPDATE tests t SET node_id = NULL WHERE node_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM roadmap_nodes n WHERE n.subject_id = t.subject_id AND n.id = t.node_id)""")
    op.execute("""ALTER TABLE roadmap_nodes ADD CONSTRAINT fk_roadmap_nodes_parent
                  FOREIGN KEY (subject_id, parent_node_id) REFERENCES roadmap_nodes(subject_id, id) ON DELETE SET NULL (parent_node_id)""")
    op.execute("""ALTER TABLE tests ADD CONSTRAINT fk_tests_node
                  FOREIGN KEY (subject_id, node_id) REFERENCES roadmap_nodes(subject_id, id) ON DELETE SET NULL (node_id)""")
    for table, (parent, column) in CHILD_TABLES.items():
        op.execute(f"""ALTER TABLE {table} ADD CONSTRAINT fk_{table}_{column}
                       FOREIGN KEY (subject_id, {column}) REFERENCES {parent}(subject_id, id) ON DELETE CASCADE""")

    # 5. Per-user uniqueness now includes the subject.
    op.execute("ALTER TABLE user_node_progress DROP CONSTRAINT IF EXISTS uq_user_node")
    op.execute("ALTER TABLE user_node_progress ADD CONSTRAINT uq_user_node UNIQUE (user_id, subject_id, node_id)")
    op.execute("ALTER TABLE user_vocab_progress DROP CONSTRAINT IF EXISTS uq_user_card")
    op.execute("ALTER TABLE user_vocab_progress ADD CONSTRAINT uq_user_card UNIQUE (user_id, subject_id, card_id)")

    # 6. Indexes.
    for name in OBSOLETE_INDEXES:
        op.execute(f"DROP INDEX IF EXISTS {name}")
    op.execute("CREATE INDEX IF NOT EXISTS idx_roadmap_parent ON roadmap_nodes(subject_id, parent_node_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_tests_node ON tests(subject_id, node_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_attempts_test ON user_test_attempts(subject_id, test_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_attempts_user_subject ON user_test_attempts(user_id, subject_id)")


def downgrade():
    raise NotImplementedError(
        "Going back to global IDs can fail when two subjects reuse an ID. Restore a backup taken before this migration instead."
    )
