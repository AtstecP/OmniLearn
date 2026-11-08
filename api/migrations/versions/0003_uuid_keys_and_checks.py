"""Server-generated UUID keys and database-level integrity checks.

Learners no longer supply IDs: every subject, lesson, question, card, reading
and reading question gets a UUID from the database (or the API). Structure is
expressed by nesting in the import JSON and enforced here:

* single-column UUID primary keys instead of (subject_id, string id) pairs;
* lessons and questions can only link to lessons of the same subject
  (composite foreign keys on (subject_id, id));
* progress and attempt rows reference users(id) and cascade when an account
  or its content is deleted;
* CHECK constraints: non-empty titles/prompts/terms, 2-20 options, a correct
  answer that points at an existing option, valid progress statuses;
* redundant data removed: roadmap_nodes.test_ids (derived from tests.node_id),
  roadmap_nodes.prerequisites (unused), subject_id copies on progress tables.

Existing rows keep their content, hierarchy, order, progress, answers and
review schedules; only their identifiers change. The whole migration runs in
one transaction.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-08
"""
from alembic import op
from sqlalchemy import text

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

TABLES = (
    "subjects", "roadmap_nodes", "tests", "vocab_cards", "reading_passages", "reading_questions",
    "user_node_progress", "user_vocab_progress", "user_test_attempts",
)
OPTION_CHECK = (
    "CASE WHEN jsonb_typeof(options) = 'array' "
    "THEN jsonb_array_length(options) BETWEEN 2 AND 20 AND correct_index BETWEEN 0 AND jsonb_array_length(options) - 1 "
    "ELSE false END"
)


def run(sql: str):
    op.execute(sql)


def upgrade():
    conn = op.get_bind()
    orphans = conn.execute(text("SELECT count(*) FROM subjects WHERE owner_user_id IS NULL")).scalar()
    if orphans:
        raise RuntimeError(f"{orphans} subject(s) have no owner. Assign or delete them before running migration 0003.")

    # 1. New UUID identity for every content row.
    for table in ("subjects", "roadmap_nodes", "tests", "vocab_cards", "reading_passages", "reading_questions"):
        run(f"ALTER TABLE {table} ADD COLUMN uid uuid NOT NULL DEFAULT gen_random_uuid()")

    # 2. Translate every reference from the old string keys to the new UUIDs.
    run("ALTER TABLE roadmap_nodes ADD COLUMN subject_uid uuid, ADD COLUMN parent_uid uuid")
    run("UPDATE roadmap_nodes n SET subject_uid = s.uid FROM subjects s WHERE s.id = n.subject_id")
    run("UPDATE roadmap_nodes n SET parent_uid = p.uid FROM roadmap_nodes p WHERE p.subject_id = n.subject_id AND p.id = n.parent_node_id")

    # Older imports could link a question only through the lesson's test_ids list; keep that link.
    run("""UPDATE tests t SET node_id = n.id FROM roadmap_nodes n
           WHERE t.node_id IS NULL AND n.subject_id = t.subject_id AND t.id = ANY(n.test_ids)""")
    run("ALTER TABLE tests ADD COLUMN subject_uid uuid, ADD COLUMN node_uid uuid, ADD COLUMN new_order integer NOT NULL DEFAULT 0")
    run("UPDATE tests t SET subject_uid = s.uid FROM subjects s WHERE s.id = t.subject_id")
    run("UPDATE tests t SET node_uid = n.uid FROM roadmap_nodes n WHERE n.subject_id = t.subject_id AND n.id = t.node_id")
    # Keep the order a lesson listed its questions in (old test_ids), then creation order.
    run("""UPDATE tests t SET new_order = r.pos FROM (
             SELECT t2.subject_id, t2.id,
                    row_number() OVER (PARTITION BY t2.subject_id, t2.node_id
                                       ORDER BY array_position(n.test_ids, t2.id) NULLS LAST, t2.created_at, t2.id) - 1 AS pos
             FROM tests t2 LEFT JOIN roadmap_nodes n ON n.subject_id = t2.subject_id AND n.id = t2.node_id) r
           WHERE r.subject_id = t.subject_id AND r.id = t.id""")

    for table in ("vocab_cards", "reading_passages"):
        run(f"ALTER TABLE {table} ADD COLUMN subject_uid uuid")
        run(f"UPDATE {table} x SET subject_uid = s.uid FROM subjects s WHERE s.id = x.subject_id")
    run("ALTER TABLE reading_passages ADD COLUMN new_order integer NOT NULL DEFAULT 0")
    run("""UPDATE reading_passages p SET new_order = r.pos FROM (
             SELECT subject_id, id, row_number() OVER (PARTITION BY subject_id ORDER BY created_at, id) - 1 AS pos
             FROM reading_passages) r
           WHERE r.subject_id = p.subject_id AND r.id = p.id""")

    run("ALTER TABLE reading_questions ADD COLUMN reading_uid uuid")
    run("UPDATE reading_questions q SET reading_uid = p.uid FROM reading_passages p WHERE p.subject_id = q.subject_id AND p.id = q.reading_id")

    for table, parent, column in (("user_node_progress", "roadmap_nodes", "node_id"),
                                  ("user_vocab_progress", "vocab_cards", "card_id"),
                                  ("user_test_attempts", "tests", "test_id")):
        run(f"ALTER TABLE {table} ADD COLUMN target_uid uuid, ADD COLUMN user_uid uuid")
        run(f"UPDATE {table} x SET target_uid = p.uid FROM {parent} p WHERE p.subject_id = x.subject_id AND p.id = x.{column}")
        run(f"UPDATE {table} x SET user_uid = u.id FROM users u WHERE u.id::text = x.user_id")
        # Rows for deleted accounts or content were unreachable already.
        run(f"DELETE FROM {table} WHERE target_uid IS NULL OR user_uid IS NULL")

    # 3. Drop every old key and link on these tables (foreign keys first).
    tables = ",".join(f"'{t}'::regclass" for t in TABLES)
    for kind in ("f", "u", "p", "c"):
        rows = conn.execute(text(f"SELECT conrelid::regclass::text, conname FROM pg_constraint WHERE contype = :k AND conrelid IN ({tables})"), {"k": kind}).all()
        for table, name in rows:
            run(f'ALTER TABLE {table} DROP CONSTRAINT IF EXISTS "{name}"')

    # 4. Swap the columns (indexes on dropped columns disappear with them).
    run("ALTER TABLE subjects DROP COLUMN id")
    run("ALTER TABLE subjects RENAME COLUMN uid TO id")

    run("ALTER TABLE roadmap_nodes DROP COLUMN id, DROP COLUMN subject_id, DROP COLUMN parent_node_id, DROP COLUMN test_ids, DROP COLUMN prerequisites")
    run("ALTER TABLE roadmap_nodes RENAME COLUMN uid TO id")
    run("ALTER TABLE roadmap_nodes RENAME COLUMN subject_uid TO subject_id")
    run("ALTER TABLE roadmap_nodes RENAME COLUMN parent_uid TO parent_node_id")

    run("ALTER TABLE tests DROP COLUMN id, DROP COLUMN subject_id, DROP COLUMN node_id")
    run("ALTER TABLE tests RENAME COLUMN uid TO id")
    run("ALTER TABLE tests RENAME COLUMN subject_uid TO subject_id")
    run("ALTER TABLE tests RENAME COLUMN node_uid TO node_id")
    run("ALTER TABLE tests RENAME COLUMN new_order TO order_index")

    for table in ("vocab_cards", "reading_passages"):
        run(f"ALTER TABLE {table} DROP COLUMN id, DROP COLUMN subject_id")
        run(f"ALTER TABLE {table} RENAME COLUMN uid TO id")
        run(f"ALTER TABLE {table} RENAME COLUMN subject_uid TO subject_id")
    run("ALTER TABLE reading_passages RENAME COLUMN new_order TO order_index")

    run("ALTER TABLE reading_questions DROP COLUMN id, DROP COLUMN reading_id, DROP COLUMN subject_id")
    run("ALTER TABLE reading_questions RENAME COLUMN uid TO id")
    run("ALTER TABLE reading_questions RENAME COLUMN reading_uid TO reading_id")

    run("ALTER TABLE user_node_progress DROP COLUMN id, DROP COLUMN node_id, DROP COLUMN subject_id, DROP COLUMN user_id")
    run("ALTER TABLE user_node_progress RENAME COLUMN target_uid TO node_id")
    run("ALTER TABLE user_vocab_progress DROP COLUMN id, DROP COLUMN card_id, DROP COLUMN subject_id, DROP COLUMN user_id")
    run("ALTER TABLE user_vocab_progress RENAME COLUMN target_uid TO card_id")
    run("ALTER TABLE user_test_attempts DROP COLUMN test_id, DROP COLUMN subject_id, DROP COLUMN user_id")
    run("ALTER TABLE user_test_attempts RENAME COLUMN target_uid TO test_id")
    for table in ("user_node_progress", "user_vocab_progress", "user_test_attempts"):
        run(f"ALTER TABLE {table} RENAME COLUMN user_uid TO user_id")

    # 5. Clean values that the new checks would reject.
    run("UPDATE subjects SET title = 'Untitled subject' WHERE btrim(title) = ''")
    run("UPDATE roadmap_nodes SET title = 'Untitled lesson' WHERE btrim(title) = ''")
    run("UPDATE reading_passages SET title = 'Untitled reading' WHERE btrim(title) = ''")
    run("UPDATE roadmap_nodes SET content_markdown = '' WHERE content_markdown IS NULL")
    run("""UPDATE roadmap_nodes n SET order_index = r.pos FROM (
             SELECT id, row_number() OVER (PARTITION BY subject_id, parent_node_id ORDER BY order_index NULLS LAST, created_at, id) - 1 AS pos
             FROM roadmap_nodes) r
           WHERE r.id = n.id""")
    run("UPDATE reading_questions SET order_index = 0 WHERE order_index IS NULL OR order_index < 0")
    for table in ("tests", "vocab_cards"):
        run(f"UPDATE {table} SET tags = '{{}}' WHERE tags IS NULL")
    run("UPDATE user_node_progress SET status = 'in_progress' WHERE status IS NULL OR status NOT IN ('in_progress', 'mastered')")
    run("UPDATE user_vocab_progress SET status = 'learning' WHERE status IS NULL OR status NOT IN ('learning', 'reviewing', 'mastered')")
    run("""UPDATE user_vocab_progress SET interval_days = coalesce(interval_days, 0), ease_factor = coalesce(ease_factor, 2.5),
           consecutive_correct = coalesce(consecutive_correct, 0), due_date = coalesce(due_date, now())""")
    run("UPDATE user_test_attempts SET is_flagged_mistake = coalesce(is_flagged_mistake, false), consecutive_correct_in_retest = coalesce(consecutive_correct_in_retest, 0)")

    # 6. New keys, links and checks.
    run("""ALTER TABLE subjects
             ALTER COLUMN owner_user_id SET NOT NULL,
             ADD CONSTRAINT subjects_pkey PRIMARY KEY (id),
             ADD CONSTRAINT fk_subjects_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
             ADD CONSTRAINT ck_subjects_title CHECK (btrim(title) <> '')""")

    run("""ALTER TABLE roadmap_nodes
             ALTER COLUMN subject_id SET NOT NULL,
             ALTER COLUMN order_index SET NOT NULL, ALTER COLUMN order_index SET DEFAULT 0,
             ALTER COLUMN content_markdown SET DEFAULT '',
             ADD CONSTRAINT roadmap_nodes_pkey PRIMARY KEY (id),
             ADD CONSTRAINT uq_roadmap_nodes_subject_id UNIQUE (subject_id, id),
             ADD CONSTRAINT fk_roadmap_nodes_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
             ADD CONSTRAINT fk_roadmap_nodes_parent FOREIGN KEY (subject_id, parent_node_id)
                 REFERENCES roadmap_nodes(subject_id, id) ON DELETE SET NULL (parent_node_id),
             ADD CONSTRAINT ck_roadmap_nodes_not_own_parent CHECK (parent_node_id IS NULL OR parent_node_id <> id),
             ADD CONSTRAINT ck_roadmap_nodes_title CHECK (btrim(title) <> ''),
             ADD CONSTRAINT ck_roadmap_nodes_order CHECK (order_index >= 0)""")

    run(f"""ALTER TABLE tests
             ALTER COLUMN subject_id SET NOT NULL,
             ALTER COLUMN order_index SET DEFAULT 0,
             ALTER COLUMN tags SET NOT NULL, ALTER COLUMN tags SET DEFAULT '{{}}',
             ALTER COLUMN explanation SET DEFAULT '',
             ADD CONSTRAINT tests_pkey PRIMARY KEY (id),
             ADD CONSTRAINT fk_tests_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
             ADD CONSTRAINT fk_tests_node FOREIGN KEY (subject_id, node_id)
                 REFERENCES roadmap_nodes(subject_id, id) ON DELETE SET NULL (node_id),
             ADD CONSTRAINT ck_tests_prompt CHECK (btrim(prompt) <> ''),
             ADD CONSTRAINT ck_tests_options CHECK ({OPTION_CHECK}),
             ADD CONSTRAINT ck_tests_order CHECK (order_index >= 0)""")

    run("""ALTER TABLE vocab_cards
             ALTER COLUMN subject_id SET NOT NULL,
             ALTER COLUMN tags SET NOT NULL, ALTER COLUMN tags SET DEFAULT '{}',
             ADD CONSTRAINT vocab_cards_pkey PRIMARY KEY (id),
             ADD CONSTRAINT fk_vocab_cards_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
             ADD CONSTRAINT ck_vocab_cards_term CHECK (btrim(term) <> '')""")

    run("""ALTER TABLE reading_passages
             ALTER COLUMN subject_id SET NOT NULL,
             ALTER COLUMN order_index SET DEFAULT 0,
             ADD CONSTRAINT reading_passages_pkey PRIMARY KEY (id),
             ADD CONSTRAINT fk_reading_passages_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
             ADD CONSTRAINT ck_reading_passages_title CHECK (btrim(title) <> ''),
             ADD CONSTRAINT ck_reading_passages_order CHECK (order_index >= 0)""")

    run(f"""ALTER TABLE reading_questions
             ALTER COLUMN reading_id SET NOT NULL,
             ALTER COLUMN order_index SET NOT NULL, ALTER COLUMN order_index SET DEFAULT 0,
             ALTER COLUMN explanation SET DEFAULT '',
             ADD CONSTRAINT reading_questions_pkey PRIMARY KEY (id),
             ADD CONSTRAINT fk_reading_questions_reading FOREIGN KEY (reading_id) REFERENCES reading_passages(id) ON DELETE CASCADE,
             ADD CONSTRAINT ck_reading_questions_prompt CHECK (btrim(prompt) <> ''),
             ADD CONSTRAINT ck_reading_questions_options CHECK ({OPTION_CHECK}),
             ADD CONSTRAINT ck_reading_questions_order CHECK (order_index >= 0)""")

    run("""ALTER TABLE user_node_progress
             ALTER COLUMN node_id SET NOT NULL, ALTER COLUMN user_id SET NOT NULL,
             ALTER COLUMN status SET NOT NULL, ALTER COLUMN status SET DEFAULT 'in_progress',
             ADD CONSTRAINT user_node_progress_pkey PRIMARY KEY (user_id, node_id),
             ADD CONSTRAINT fk_user_node_progress_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
             ADD CONSTRAINT fk_user_node_progress_node FOREIGN KEY (node_id) REFERENCES roadmap_nodes(id) ON DELETE CASCADE,
             ADD CONSTRAINT ck_user_node_progress_status CHECK (status IN ('in_progress', 'mastered'))""")

    run("""ALTER TABLE user_vocab_progress
             ALTER COLUMN card_id SET NOT NULL, ALTER COLUMN user_id SET NOT NULL,
             ALTER COLUMN interval_days SET NOT NULL, ALTER COLUMN ease_factor SET NOT NULL,
             ALTER COLUMN consecutive_correct SET NOT NULL, ALTER COLUMN due_date SET NOT NULL,
             ALTER COLUMN status SET NOT NULL, ALTER COLUMN status SET DEFAULT 'learning',
             ADD CONSTRAINT user_vocab_progress_pkey PRIMARY KEY (user_id, card_id),
             ADD CONSTRAINT fk_user_vocab_progress_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
             ADD CONSTRAINT fk_user_vocab_progress_card FOREIGN KEY (card_id) REFERENCES vocab_cards(id) ON DELETE CASCADE,
             ADD CONSTRAINT ck_user_vocab_progress_status CHECK (status IN ('learning', 'reviewing', 'mastered')),
             ADD CONSTRAINT ck_user_vocab_progress_values CHECK (interval_days >= 0 AND ease_factor >= 1 AND consecutive_correct >= 0)""")

    run("""ALTER TABLE user_test_attempts
             ALTER COLUMN test_id SET NOT NULL, ALTER COLUMN user_id SET NOT NULL,
             ALTER COLUMN id SET DEFAULT gen_random_uuid(),
             ALTER COLUMN is_flagged_mistake SET NOT NULL, ALTER COLUMN consecutive_correct_in_retest SET NOT NULL,
             ADD CONSTRAINT user_test_attempts_pkey PRIMARY KEY (id),
             ADD CONSTRAINT fk_user_test_attempts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
             ADD CONSTRAINT fk_user_test_attempts_test FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE,
             ADD CONSTRAINT ck_user_test_attempts_values CHECK (selected_index >= 0 AND consecutive_correct_in_retest >= 0)""")

    # 7. Indexes for the queries the API runs.
    for name in ("idx_subject_owner", "ix_subjects_owner_user_id", "ix_user_test_attempts_is_flagged_mistake",
                 "idx_vocab_term", "ix_vocab_cards_term", "idx_vocab_tags", "idx_tests_tags", "idx_vocab_due"):
        run(f"DROP INDEX IF EXISTS {name}")
    run("CREATE INDEX idx_subjects_owner ON subjects(owner_user_id, created_at)")
    run("CREATE INDEX idx_roadmap_nodes_tree ON roadmap_nodes(subject_id, parent_node_id, order_index)")
    run("CREATE INDEX idx_tests_subject ON tests(subject_id)")
    run("CREATE INDEX idx_tests_node ON tests(node_id, order_index)")
    run("CREATE INDEX idx_vocab_cards_subject ON vocab_cards(subject_id, created_at)")
    run("CREATE INDEX idx_reading_passages_subject ON reading_passages(subject_id, order_index)")
    run("CREATE INDEX idx_reading_questions_reading ON reading_questions(reading_id, order_index)")
    run("CREATE INDEX idx_user_node_progress_node ON user_node_progress(node_id)")
    run("CREATE INDEX idx_user_vocab_progress_card ON user_vocab_progress(card_id)")
    run("CREATE INDEX idx_user_vocab_progress_due ON user_vocab_progress(user_id, due_date)")
    run("CREATE INDEX idx_user_test_attempts_lookup ON user_test_attempts(user_id, test_id, attempted_at DESC)")
    run("CREATE INDEX idx_user_test_attempts_test ON user_test_attempts(test_id)")


def downgrade():
    raise NotImplementedError("Old string IDs cannot be restored. Restore the Neon branch or backup taken before this migration.")
