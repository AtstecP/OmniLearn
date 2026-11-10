"""Dictation phrases: the sentences practised in the Dictation tool.

Each row is one phrase with its answer: `answer` is the sentence that is spoken and typed,
`translation` is what is shown. They have their own table (not vocabulary cards) and their own
"phrases" list in the import bundle. Additive only.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-09
"""
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE dictation_phrases (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
            order_index integer NOT NULL DEFAULT 0,
            answer text NOT NULL CHECK (length(btrim(answer)) > 0),
            translation text NOT NULL DEFAULT '',
            audio_url varchar(1024),
            tags text[] NOT NULL DEFAULT '{}',
            created_at timestamptz NOT NULL DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX ix_dictation_phrases_subject ON dictation_phrases (subject_id, order_index)")


def downgrade() -> None:
    op.execute("DROP TABLE dictation_phrases")
