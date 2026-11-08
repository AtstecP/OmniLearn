"""Favorites: a star on lessons, reading texts and test questions.

One row per user and starred item. item_id points at a lesson, reading passage or
question depending on kind, so it has no foreign key of its own; rows are removed
with the subject and ignored when the item no longer exists. Additive only.

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-08
"""
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE user_favorites (
            user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
            kind varchar(16) NOT NULL CHECK (kind IN ('lesson', 'reading', 'question')),
            item_id uuid NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (user_id, kind, item_id)
        )
    """)
    op.execute("CREATE INDEX ix_user_favorites_subject ON user_favorites (user_id, subject_id)")


def downgrade() -> None:
    op.execute("DROP TABLE user_favorites")
