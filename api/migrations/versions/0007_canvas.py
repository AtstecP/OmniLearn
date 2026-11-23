"""Freeform canvas: positions and block types on roadmap_nodes, plus roadmap_edges.

* roadmap_nodes gets position_x/position_y (canvas coordinates), optional width/height,
  node_type (material = a lesson, topic, quiz, note, resource) and a free metadata JSONB.
  Existing rows become 'material' lessons. parent_node_id and order_index stay: the list
  view, the test center, export and the import format still use the hierarchy.
* roadmap_edges stores connections between any two blocks of the same subject. They are
  visual/semantic only and never block access to a lesson.
* subjects.canvas_version is bumped by every canvas save, so a stale browser tab cannot
  silently overwrite newer changes (the API answers 409 and the client merges).

Existing lessons are laid out like the old tree (each depth a column, sub-topics stacked
below their parent) and every parent -> child link becomes an edge. Lesson ids, tests,
progress and favourites are untouched. Additive only.

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-17
"""
from collections import defaultdict

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

COL_W, ROW_H = 340, 120


def upgrade() -> None:
    op.execute("""
        ALTER TABLE roadmap_nodes
            ADD COLUMN position_x double precision NOT NULL DEFAULT 0,
            ADD COLUMN position_y double precision NOT NULL DEFAULT 0,
            ADD COLUMN width double precision,
            ADD COLUMN height double precision,
            ADD COLUMN node_type varchar(16) NOT NULL DEFAULT 'material',
            ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
            ADD CONSTRAINT ck_roadmap_nodes_type CHECK (node_type IN ('material', 'topic', 'quiz', 'note', 'resource'))
    """)
    op.execute("CREATE INDEX ix_roadmap_nodes_subject_type ON roadmap_nodes (subject_id, node_type)")
    op.execute("ALTER TABLE subjects ADD COLUMN canvas_version integer NOT NULL DEFAULT 0")
    op.execute("""
        CREATE TABLE roadmap_edges (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
            source_node_id uuid NOT NULL,
            target_node_id uuid NOT NULL,
            edge_type varchar(16) NOT NULL DEFAULT 'default',
            label varchar(255),
            metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT fk_roadmap_edges_source FOREIGN KEY (subject_id, source_node_id) REFERENCES roadmap_nodes (subject_id, id) ON DELETE CASCADE,
            CONSTRAINT fk_roadmap_edges_target FOREIGN KEY (subject_id, target_node_id) REFERENCES roadmap_nodes (subject_id, id) ON DELETE CASCADE,
            CONSTRAINT ck_roadmap_edges_not_self CHECK (source_node_id <> target_node_id),
            CONSTRAINT ck_roadmap_edges_type CHECK (edge_type IN ('default', 'related_to', 'explains', 'prerequisite', 'references', 'tests'))
        )
    """)
    op.execute("CREATE INDEX ix_roadmap_edges_subject ON roadmap_edges (subject_id)")
    op.execute("CREATE INDEX ix_roadmap_edges_source ON roadmap_edges (source_node_id)")
    op.execute("CREATE INDEX ix_roadmap_edges_target ON roadmap_edges (target_node_id)")

    # Initial layout from the old tree, one subject at a time.
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, subject_id, parent_node_id FROM roadmap_nodes ORDER BY subject_id, order_index, created_at")).all()
    by_subject = defaultdict(list)
    for r in rows:
        by_subject[r.subject_id].append(r)
    positions, edges = [], []
    for subject_id, nodes in by_subject.items():
        ids = {n.id for n in nodes}
        children = defaultdict(list)
        for n in nodes:
            children[n.parent_node_id if n.parent_node_id in ids else None].append(n.id)
        row = 0
        seen = set()

        def walk(node_id, depth):
            nonlocal row
            seen.add(node_id)
            positions.append({"id": node_id, "x": depth * COL_W, "y": row * ROW_H})
            row += 1
            for c in children[node_id]:
                if c not in seen:
                    edges.append({"sid": subject_id, "s": node_id, "t": c})
                    walk(c, depth + 1)

        for root in children[None]:
            walk(root, 0)
            row += 1  # a gap between main steps
        for n in nodes:  # anything in a broken cycle
            if n.id not in seen:
                walk(n.id, 0)
    if positions:
        conn.execute(sa.text("UPDATE roadmap_nodes SET position_x = :x, position_y = :y WHERE id = :id"), positions)
    if edges:
        conn.execute(sa.text("INSERT INTO roadmap_edges (subject_id, source_node_id, target_node_id) VALUES (:sid, :s, :t)"), edges)


def downgrade() -> None:
    # Canvas-only blocks (topics, notes, resources, quizzes) cannot exist without node_type.
    op.execute("DELETE FROM roadmap_nodes WHERE node_type <> 'material'")
    op.execute("DROP TABLE roadmap_edges")
    op.execute("ALTER TABLE subjects DROP COLUMN canvas_version")
    op.execute("DROP INDEX ix_roadmap_nodes_subject_type")
    op.execute("""
        ALTER TABLE roadmap_nodes DROP CONSTRAINT ck_roadmap_nodes_type,
            DROP COLUMN metadata, DROP COLUMN node_type, DROP COLUMN height, DROP COLUMN width,
            DROP COLUMN position_y, DROP COLUMN position_x
    """)
