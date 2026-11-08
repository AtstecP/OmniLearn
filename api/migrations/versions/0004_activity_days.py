"""Practice calendar: one row per user per day with the number of practice actions.

Records test answers, vocabulary reviews and lessons marked mastered. Existing
history is backfilled from attempts, the last vocabulary review per card and
mastery dates (UTC days; later days use the learner's own calendar day).
Additive only: no existing table is changed.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-08
"""
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE user_activity_days (
            user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            day date NOT NULL,
            actions integer NOT NULL DEFAULT 0 CHECK (actions >= 0),
            PRIMARY KEY (user_id, day)
        )
    """)
    op.execute("""
        INSERT INTO user_activity_days (user_id, day, actions)
        SELECT user_id, day, count(*) FROM (
            SELECT user_id, (attempted_at AT TIME ZONE 'UTC')::date AS day FROM user_test_attempts
            UNION ALL
            SELECT user_id, (last_reviewed_at AT TIME ZONE 'UTC')::date FROM user_vocab_progress WHERE last_reviewed_at IS NOT NULL
            UNION ALL
            SELECT user_id, (completed_at AT TIME ZONE 'UTC')::date FROM user_node_progress WHERE completed_at IS NOT NULL
        ) a GROUP BY user_id, day
    """)


def downgrade() -> None:
    op.execute("DROP TABLE user_activity_days")
