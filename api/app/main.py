from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4
from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import and_, delete, desc, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from .config import DEFAULT_JWT_SECRET, settings
from .database import get_db
from . import models as m
from .auth import clear_session_cookie, get_current_user, hash_password, set_session_cookie, verify_password
from .bundle import Bundle, BundleError, Lesson, Question, parse_bundle
from .schemas import (AccountDeleteIn, AttemptIn, CardCreate, LoginIn, NodeCreate, NodeUpdate, PasswordChangeIn, RegisterIn,
                      ReviewIn, RoadmapLayoutIn, SubjectDeleteIn, SubjectIn, TestCreate)

if settings.cookie_secure and (settings.jwt_secret == DEFAULT_JWT_SECRET or len(settings.jwt_secret) < 32):
    raise RuntimeError("JWT_SECRET must be a unique random value of at least 32 characters when COOKIE_SECURE is on (production).")

# The schema is managed by Alembic (`alembic upgrade head`); the API never creates or alters tables.
app = FastAPI(title="Learnify API", version="3.0.0", description="Schema-driven learning engine API")
app.add_middleware(CORSMiddleware, allow_origins=settings.allowed_origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
def health(): return {"status": "ok"}


# ---------------------------------------------------------------- helpers

def local_day(x_local_date: str | None = Header(None)) -> date:
    """The learner's calendar day: the browser sends its local date; anything odd falls back to UTC."""
    utc = datetime.now(timezone.utc).date()
    try:
        d = date.fromisoformat(x_local_date or "")
        return d if abs((d - utc).days) <= 1 else utc
    except ValueError:
        return utc


def log_activity(db: Session, user: m.User, day: date, n: int = 1):
    """Count practice on a day (committed with the caller's transaction)."""
    stmt = pg_insert(m.UserActivityDay).values(user_id=user.id, day=day, actions=n)
    db.execute(stmt.on_conflict_do_update(index_elements=["user_id", "day"], set_={"actions": m.UserActivityDay.actions + n}))


def public_user(user: m.User):
    return {"id": str(user.id), "email": user.email, "full_name": user.full_name}


def dump(obj):
    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns}


def require_subject(db: Session, subject_id: UUID, user: m.User) -> m.Subject:
    subject = db.get(m.Subject, subject_id)
    if not subject or subject.owner_user_id != user.id:
        raise HTTPException(404, "Subject not found")
    return subject


def require_item(db: Session, model, subject_id: UUID, item_id: UUID, user: m.User, label: str):
    require_subject(db, subject_id, user)
    obj = db.get(model, item_id)
    if not obj or obj.subject_id != subject_id:
        raise HTTPException(404, f"{label} not found")
    return obj


def commit_or_422(db: Session):
    """The database checks structure too; turn a violated constraint into a clear 422."""
    try:
        db.commit()
    except IntegrityError as e:
        db.rollback()
        constraint = getattr(getattr(e.orig, "diag", None), "constraint_name", None)
        raise HTTPException(422, f"The data breaks a database rule ({constraint or 'integrity check'}).")


def node_json(node: m.RoadmapNode, test_ids: list[UUID]):
    return {**dump(node), "test_ids": test_ids}


# ---------------------------------------------------------------- accounts

@app.post("/auth/register", status_code=201)
def register(payload: RegisterIn, response: Response, db: Session = Depends(get_db)):
    if db.scalar(select(m.User).where(m.User.email == payload.email)):
        raise HTTPException(409, "An account with that email already exists")
    user = m.User(email=payload.email, full_name=payload.full_name.strip(), password_hash=hash_password(payload.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    expires_in = set_session_cookie(response, user)
    return {"expires_in": expires_in, "user": public_user(user)}


@app.post("/auth/login")
def login(payload: LoginIn, response: Response, db: Session = Depends(get_db)):
    user = db.scalar(select(m.User).where(m.User.email == payload.email))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(401, "Email or password is incorrect")
    expires_in = set_session_cookie(response, user)
    return {"expires_in": expires_in, "user": public_user(user)}


@app.post("/auth/logout")
def logout(response: Response):
    clear_session_cookie(response)
    return {"status": "signed_out"}


@app.get("/auth/me")
def me(user: m.User = Depends(get_current_user)):
    return public_user(user)


@app.post("/auth/change-password")
def change_password(payload: PasswordChangeIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(403, "Current password is incorrect")
    user.password_hash = hash_password(payload.new_password)
    db.commit()
    return {"status": "password_changed"}


@app.delete("/auth/account")
def delete_account(payload: AccountDeleteIn, response: Response, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(403, "Current password is incorrect")
    if payload.confirmation != "DELETE":
        raise HTTPException(422, "Type DELETE to confirm account reset")
    db.delete(user)
    db.commit()
    clear_session_cookie(response)
    return {"status": "account_deleted"}


# ---------------------------------------------------------------- subjects

@app.get("/subjects")
def list_subjects(db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    return db.scalars(select(m.Subject).where(m.Subject.owner_user_id == user.id).order_by(m.Subject.created_at)).all()


@app.post("/subjects", status_code=201)
def create_subject(payload: SubjectIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    obj = m.Subject(title=payload.title, description=payload.description, target_level=payload.target_level, owner_user_id=user.id)
    db.add(obj); commit_or_422(db); db.refresh(obj)
    return obj


@app.get("/subjects/{subject_id}")
def get_subject(subject_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    return require_subject(db, subject_id, user)


@app.delete("/subjects/{subject_id}", status_code=204)
def delete_subject(subject_id: UUID, payload: SubjectDeleteIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    """Delete a subject and everything in it (lessons, questions, cards, readings, progress)."""
    subject = require_subject(db, subject_id, user)
    if payload.confirmation.strip() != subject.title.strip():
        raise HTTPException(422, "Type the subject's exact title to confirm")
    db.delete(subject)
    db.commit()


def roadmap_rows(db: Session, subject_id: UUID):
    return db.scalars(select(m.RoadmapNode).where(m.RoadmapNode.subject_id == subject_id)
                      .order_by(m.RoadmapNode.order_index, m.RoadmapNode.created_at)).all()


def test_rows(db: Session, subject_id: UUID):
    return db.scalars(select(m.TestQuestion).where(m.TestQuestion.subject_id == subject_id)
                      .order_by(m.TestQuestion.order_index, m.TestQuestion.created_at)).all()


def tree_order(nodes):
    """Depth-first order: each main step followed by its sub-topics, so 'next lesson'
    and list views follow the curriculum. Orphans (bad parents) go last."""
    children = defaultdict(list)
    ids = {n.id for n in nodes}
    for n in nodes:
        children[n.parent_node_id if n.parent_node_id in ids else None].append(n)
    out, seen = [], set()

    def walk(parent):
        for n in children[parent]:
            if n.id not in seen:
                seen.add(n.id)
                out.append(n)
                walk(n.id)
    walk(None)
    return out + [n for n in nodes if n.id not in seen]


def roadmap_json(nodes, tests):
    nodes = tree_order(nodes)
    linked = defaultdict(list)
    for t in tests:
        if t.node_id:
            linked[t.node_id].append(t.id)
    return [node_json(n, linked[n.id]) for n in nodes]


def progress_map(db: Session, subject_id: UUID, user: m.User):
    rows = db.execute(select(m.UserNodeProgress.node_id, m.UserNodeProgress.status)
                      .join(m.RoadmapNode, m.RoadmapNode.id == m.UserNodeProgress.node_id)
                      .where(m.RoadmapNode.subject_id == subject_id, m.UserNodeProgress.user_id == user.id)).all()
    return {str(node_id): status for node_id, status in rows}


def vocab_rows(db: Session, subject_id: UUID, user: m.User, due_only: bool = False):
    rows = db.execute(
        select(m.VocabCard, m.UserVocabProgress)
        .outerjoin(m.UserVocabProgress, and_(m.UserVocabProgress.card_id == m.VocabCard.id, m.UserVocabProgress.user_id == user.id))
        .where(m.VocabCard.subject_id == subject_id).order_by(m.VocabCard.created_at)
    ).all()
    now = datetime.now(timezone.utc)
    out = []
    for card, progress in rows:
        is_due = not progress or progress.due_date <= now
        if due_only and not is_due:
            continue
        out.append({**dump(card), "progress": dump(progress) if progress else None, "is_due": is_due})
    return out


def reading_rows(db: Session, subject_id: UUID):
    rows = db.execute(
        select(m.ReadingPassage, m.ReadingQuestion)
        .outerjoin(m.ReadingQuestion, m.ReadingQuestion.reading_id == m.ReadingPassage.id)
        .where(m.ReadingPassage.subject_id == subject_id)
        .order_by(m.ReadingPassage.order_index, m.ReadingPassage.created_at, m.ReadingQuestion.order_index)
    ).all()
    grouped = {}
    for passage, question in rows:
        item = grouped.setdefault(passage.id, {"id": passage.id, "subject_id": passage.subject_id, "title": passage.title, "level": passage.cefr_level,
                                               "passage_markdown": passage.content, "audio_url": passage.audio_url, "questions": []})
        if question:
            item["questions"].append(dump(question))
    return list(grouped.values())


def mistake_rows(db: Session, subject_id: UUID, user: m.User):
    rows = db.execute(
        select(m.UserTestAttempt, m.TestQuestion)
        .join(m.TestQuestion, m.TestQuestion.id == m.UserTestAttempt.test_id)
        .where(m.UserTestAttempt.user_id == user.id, m.TestQuestion.subject_id == subject_id)
        .order_by(desc(m.UserTestAttempt.attempted_at))
    ).all()
    latest, failures = {}, defaultdict(int)
    for attempt, question in rows:
        failures[question.id] += not attempt.is_correct
        latest.setdefault(question.id, (attempt, question))
    return [{"question": q, "failures": failures[q.id], "streak": a.consecutive_correct_in_retest} for a, q in latest.values() if a.is_flagged_mistake]


def dashboard_numbers(subject_id, roadmap, progress, tests, cards, readings, mistakes):
    node_ids = {str(n["id"]) for n in roadmap}
    completed = sum(1 for node_id, status in progress.items() if status == "mastered" and node_id in node_ids)
    return {
        "subject_id": subject_id,
        "roadmap_nodes": len(roadmap),
        "roadmap_completed": completed,
        "roadmap_completion_percent": round(completed * 100 / len(roadmap)) if roadmap else 0,
        "vocab_due": sum(1 for c in cards if c["is_due"]),
        "mistakes": len(mistakes),
        "tests": len(tests),
        "readings": len(readings),
    }


@app.get("/subjects/{subject_id}/workspace")
def subject_workspace(subject_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    """Everything the UI needs for one subject in 7 queries; dashboard numbers are derived from the lists."""
    require_subject(db, subject_id, user)
    tests = test_rows(db, subject_id)
    roadmap = roadmap_json(roadmap_rows(db, subject_id), tests)
    progress = progress_map(db, subject_id, user)
    cards = vocab_rows(db, subject_id, user)
    readings = reading_rows(db, subject_id)
    mistakes = mistake_rows(db, subject_id, user)
    alive = {"lesson": {str(n["id"]) for n in roadmap}, "question": {str(t.id) for t in tests}, "reading": {str(r["id"]) for r in readings}}
    favs = db.execute(select(m.UserFavorite.kind, m.UserFavorite.item_id).where(m.UserFavorite.user_id == user.id, m.UserFavorite.subject_id == subject_id)
                      .order_by(m.UserFavorite.created_at.desc())).all()
    favorites = [{"kind": k, "item_id": str(i)} for k, i in favs if str(i) in alive.get(k, ())]
    return {"roadmap": roadmap, "tests": tests, "cards": cards, "readings": readings, "mistakes": mistakes, "progress": progress, "favorites": favorites,
            "dashboard": dashboard_numbers(subject_id, roadmap, progress, tests, cards, readings, mistakes)}


@app.get("/subjects/{subject_id}/dashboard")
def dashboard(subject_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    return subject_workspace(subject_id, db, user)["dashboard"]


@app.get("/subjects/{subject_id}/roadmap")
def get_roadmap(subject_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    return roadmap_json(roadmap_rows(db, subject_id), test_rows(db, subject_id))


@app.get("/subjects/{subject_id}/progress")
def get_subject_progress(subject_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    return progress_map(db, subject_id, user)


# ---------------------------------------------------------------- roadmap

def next_position(db: Session, model, *conditions) -> int:
    current = db.scalar(select(func.max(model.order_index)).where(*conditions))
    return 0 if current is None else current + 1


def same_parent(column, parent: UUID | None):
    return column.is_(None) if parent is None else column == parent


@app.put("/subjects/{subject_id}/roadmap/layout")
def update_roadmap_layout(subject_id: UUID, payload: RoadmapLayoutIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    """Move and reorder lessons in one request (used by the map editor)."""
    require_subject(db, subject_id, user)
    nodes = {n.id: n for n in roadmap_rows(db, subject_id)}
    for item in payload.nodes:
        if item.id not in nodes:
            raise HTTPException(404, f"Lesson not found: {item.id}")
        if item.parent_node_id is not None and item.parent_node_id not in nodes:
            raise HTTPException(422, f"Parent lesson not found: {item.parent_node_id}")
    parents = {n.id: n.parent_node_id for n in nodes.values()}
    for item in payload.nodes:
        parents[item.id] = item.parent_node_id
    for start in parents:
        seen, current = set(), start
        while current is not None:
            if current in seen:
                raise HTTPException(422, "A lesson cannot be placed under itself or its own sub-topics")
            seen.add(current)
            current = parents.get(current)
    for item in payload.nodes:
        nodes[item.id].parent_node_id = item.parent_node_id
        nodes[item.id].order_index = item.order_index
    commit_or_422(db)
    return roadmap_json(roadmap_rows(db, subject_id), test_rows(db, subject_id))


@app.post("/subjects/{subject_id}/nodes", status_code=201)
def create_node(subject_id: UUID, payload: NodeCreate, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    if payload.parent_node_id:
        require_item(db, m.RoadmapNode, subject_id, payload.parent_node_id, user, "Parent lesson")
    order = payload.order_index
    if order is None:
        order = next_position(db, m.RoadmapNode, m.RoadmapNode.subject_id == subject_id, same_parent(m.RoadmapNode.parent_node_id, payload.parent_node_id))
    obj = m.RoadmapNode(subject_id=subject_id, parent_node_id=payload.parent_node_id, title=payload.title, level=payload.level,
                        order_index=order, content_markdown=payload.content_markdown)
    db.add(obj); commit_or_422(db); db.refresh(obj)
    return node_json(obj, [])


@app.put("/subjects/{subject_id}/nodes/{node_id}")
def update_node(subject_id: UUID, node_id: UUID, payload: NodeUpdate, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    obj = require_item(db, m.RoadmapNode, subject_id, node_id, user, "Lesson")
    obj.title, obj.level, obj.content_markdown = payload.title, payload.level, payload.content_markdown
    commit_or_422(db); db.refresh(obj)
    return node_json(obj, list(db.scalars(select(m.TestQuestion.id).where(m.TestQuestion.node_id == node_id).order_by(m.TestQuestion.order_index))))


@app.delete("/subjects/{subject_id}/nodes/{node_id}", status_code=204)
def delete_node(subject_id: UUID, node_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    obj = require_item(db, m.RoadmapNode, subject_id, node_id, user, "Lesson")
    # Sub-topics move up one level instead of becoming main steps; linked questions stay in the bank.
    base = next_position(db, m.RoadmapNode, m.RoadmapNode.subject_id == subject_id, same_parent(m.RoadmapNode.parent_node_id, obj.parent_node_id))
    children = db.scalars(select(m.RoadmapNode).where(m.RoadmapNode.parent_node_id == node_id).order_by(m.RoadmapNode.order_index)).all()
    for i, child in enumerate(children):
        child.parent_node_id = obj.parent_node_id
        child.order_index = base + i
    db.flush()
    db.delete(obj); db.commit()


@app.delete("/subjects/{subject_id}/nodes/{node_id}/tests/{test_id}")
def unlink_test(subject_id: UUID, node_id: UUID, test_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_item(db, m.RoadmapNode, subject_id, node_id, user, "Lesson")
    question = require_item(db, m.TestQuestion, subject_id, test_id, user, "Question")
    if question.node_id == node_id:
        question.node_id = None
    db.commit()
    return {"node_id": node_id, "test_id": test_id, "linked": False}


@app.get("/subjects/{subject_id}/nodes/{node_id}/progress")
def get_node_progress(subject_id: UUID, node_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_item(db, m.RoadmapNode, subject_id, node_id, user, "Lesson")
    row = db.get(m.UserNodeProgress, (user.id, node_id))
    return row or {"node_id": node_id, "status": "not_started", "completed_at": None}


@app.post("/subjects/{subject_id}/nodes/{node_id}/progress")
def set_node_progress(subject_id: UUID, node_id: UUID, status: str = Query(..., pattern="^(in_progress|mastered)$"), db: Session = Depends(get_db), user: m.User = Depends(get_current_user), day: date = Depends(local_day)):
    require_item(db, m.RoadmapNode, subject_id, node_id, user, "Lesson")
    progress = db.get(m.UserNodeProgress, (user.id, node_id))
    if not progress:
        progress = m.UserNodeProgress(user_id=user.id, node_id=node_id)
        db.add(progress)
    progress.status = status
    progress.completed_at = datetime.now(timezone.utc) if status == "mastered" else None
    if status == "mastered":
        log_activity(db, user, day)
    db.commit(); db.refresh(progress)
    return progress


# ---------------------------------------------------------------- tests

@app.get("/subjects/{subject_id}/tests")
def list_tests(subject_id: UUID, tag: str | None = None, limit: int = Query(500, ge=1, le=5000), db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    q = select(m.TestQuestion).where(m.TestQuestion.subject_id == subject_id)
    if tag:
        q = q.where(m.TestQuestion.tags.contains([tag]))
    return db.scalars(q.order_by(m.TestQuestion.order_index, m.TestQuestion.created_at).limit(limit)).all()


@app.post("/subjects/{subject_id}/tests", status_code=201)
def create_test(subject_id: UUID, payload: TestCreate, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    if payload.node_id:
        require_item(db, m.RoadmapNode, subject_id, payload.node_id, user, "Linked lesson")
    obj = m.TestQuestion(subject_id=subject_id, node_id=payload.node_id, prompt=payload.prompt, options=payload.options,
                         correct_index=payload.correct_index, explanation=payload.explanation, tags=payload.tags,
                         order_index=next_position(db, m.TestQuestion, m.TestQuestion.subject_id == subject_id, same_parent(m.TestQuestion.node_id, payload.node_id)))
    db.add(obj); commit_or_422(db); db.refresh(obj)
    return obj


@app.delete("/subjects/{subject_id}/tests/{test_id}", status_code=204)
def delete_test(subject_id: UUID, test_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    obj = require_item(db, m.TestQuestion, subject_id, test_id, user, "Question")
    db.delete(obj); db.commit()


@app.post("/subjects/{subject_id}/tests/{test_id}/attempts")
def submit_attempt(subject_id: UUID, test_id: UUID, payload: AttemptIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user), day: date = Depends(local_day)):
    q = require_item(db, m.TestQuestion, subject_id, test_id, user, "Question")
    if payload.selected_index >= len(q.options):
        raise HTTPException(422, "Selected option is out of range")
    prev = db.scalar(select(m.UserTestAttempt).where(m.UserTestAttempt.test_id == test_id, m.UserTestAttempt.user_id == user.id)
                     .order_by(desc(m.UserTestAttempt.attempted_at)).limit(1))
    correct = payload.selected_index == q.correct_index
    streak = (prev.consecutive_correct_in_retest if prev and prev.is_flagged_mistake else 0) + 1 if correct else 0
    flagged = not correct  # a correct answer takes the question out of the mistake notebook at once
    db.add(m.UserTestAttempt(user_id=user.id, test_id=test_id, selected_index=payload.selected_index,
                             is_correct=correct, is_flagged_mistake=flagged, consecutive_correct_in_retest=streak))
    log_activity(db, user, day)
    db.commit()
    return {"is_correct": correct, "explanation": q.explanation, "correct_index": q.correct_index, "is_flagged_mistake": flagged, "consecutive_correct_in_retest": streak}


@app.get("/subjects/{subject_id}/mistakes")
def list_mistakes(subject_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    return mistake_rows(db, subject_id, user)


# ---------------------------------------------------------------- vocabulary

@app.get("/subjects/{subject_id}/vocab")
def list_vocab(subject_id: UUID, due_only: bool = False, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    return vocab_rows(db, subject_id, user, due_only)


@app.post("/subjects/{subject_id}/vocab", status_code=201)
def create_vocab(subject_id: UUID, payload: CardCreate, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    obj = m.VocabCard(subject_id=subject_id, source="manual", **payload.model_dump())
    db.add(obj); commit_or_422(db); db.refresh(obj)
    return obj


@app.delete("/subjects/{subject_id}/vocab/{card_id}", status_code=204)
def delete_vocab(subject_id: UUID, card_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    obj = require_item(db, m.VocabCard, subject_id, card_id, user, "Card")
    db.delete(obj); db.commit()


@app.post("/subjects/{subject_id}/vocab/{card_id}/review")
def review_vocab(subject_id: UUID, card_id: UUID, payload: ReviewIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user), day: date = Depends(local_day)):
    require_item(db, m.VocabCard, subject_id, card_id, user, "Card")
    p = db.get(m.UserVocabProgress, (user.id, card_id))
    if not p:
        p = m.UserVocabProgress(user_id=user.id, card_id=card_id, interval_days=0, ease_factor=2.5, consecutive_correct=0)
        db.add(p)
    ease = float(p.ease_factor or 2.5); interval = p.interval_days or 0; streak = p.consecutive_correct or 0
    if payload.rating == 0: interval = 0; streak = 0; ease = max(1.3, ease - .2)
    elif payload.rating == 1: interval = max(1, round(max(1, interval) * 1.2)); streak = 0; ease = max(1.3, ease - .15)
    elif payload.rating == 2: interval = 1 if interval < 1 else max(2, round(interval * ease)); streak += 1
    else: interval = 4 if interval < 1 else max(4, round(interval * ease * 1.3)); streak += 1; ease = min(3.2, ease + .15)
    now = datetime.now(timezone.utc)
    p.interval_days = interval; p.ease_factor = round(ease, 2); p.consecutive_correct = streak
    p.due_date = now + timedelta(days=interval); p.last_reviewed_at = now
    p.status = "mastered" if interval >= 21 else "reviewing" if interval > 1 else "learning"
    log_activity(db, user, day)
    db.commit(); db.refresh(p)
    return p


# ---------------------------------------------------------------- readings

@app.get("/subjects/{subject_id}/readings")
def list_readings(subject_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    return reading_rows(db, subject_id)


@app.delete("/subjects/{subject_id}/readings/{reading_id}", status_code=204)
def delete_reading(subject_id: UUID, reading_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    reading = require_item(db, m.ReadingPassage, subject_id, reading_id, user, "Reading")
    db.delete(reading); db.commit()


# ---------------------------------------------------------------- activity

@app.get("/activity")
def get_activity(days: int = Query(400, ge=1, le=800), today: date = Depends(local_day), db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    """Practice days for the calendar plus streaks. The current streak survives until the end of
    today: if you have not practised yet today it counts back from yesterday."""
    rows = db.execute(select(m.UserActivityDay.day, m.UserActivityDay.actions).where(m.UserActivityDay.user_id == user.id)
                      .order_by(m.UserActivityDay.day)).all()
    active = {r.day: r.actions for r in rows}
    cursor = today if today in active else today - timedelta(days=1)
    current = 0
    while cursor in active:
        current += 1
        cursor -= timedelta(days=1)
    longest = run = 0
    prev = None
    for d in sorted(active):
        run = run + 1 if prev and (d - prev).days == 1 else 1
        longest, prev = max(longest, run), d
    since = today - timedelta(days=days)
    return {"today": today.isoformat(), "current_streak": current, "longest_streak": longest, "total_days": len(active),
            "active_today": today in active, "days": {d.isoformat(): n for d, n in active.items() if d >= since}}


# ---------------------------------------------------------------- favorites

FAVORITE_MODELS = {"lesson": (m.RoadmapNode, "Lesson"), "reading": (m.ReadingPassage, "Reading"), "question": (m.TestQuestion, "Question")}


def favorite_target(kind: str):
    if kind not in FAVORITE_MODELS:
        raise HTTPException(404, "Unknown favorite type")
    return FAVORITE_MODELS[kind]


@app.put("/subjects/{subject_id}/favorites/{kind}/{item_id}", status_code=204)
def add_favorite(subject_id: UUID, kind: str, item_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    model, label = favorite_target(kind)
    require_item(db, model, subject_id, item_id, user, label)
    db.execute(pg_insert(m.UserFavorite).values(user_id=user.id, subject_id=subject_id, kind=kind, item_id=item_id).on_conflict_do_nothing())
    db.commit()


@app.delete("/subjects/{subject_id}/favorites/{kind}/{item_id}", status_code=204)
def remove_favorite(subject_id: UUID, kind: str, item_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    favorite_target(kind)
    require_subject(db, subject_id, user)
    db.execute(delete(m.UserFavorite).where(m.UserFavorite.user_id == user.id, m.UserFavorite.subject_id == subject_id,
                                            m.UserFavorite.kind == kind, m.UserFavorite.item_id == item_id))
    db.commit()


# ---------------------------------------------------------------- import / export

def bundle_or_422(raw: Any) -> Bundle:
    try:
        return parse_bundle(raw)
    except BundleError as e:
        raise HTTPException(422, {"message": "The study material has problems that need fixing", "errors": e.errors})


def question_row(subject_id: UUID, node_id: UUID | None, q: Question, position: int) -> m.TestQuestion:
    return m.TestQuestion(id=uuid4(), subject_id=subject_id, node_id=node_id, order_index=position, prompt=q.prompt,
                          options=q.options, correct_index=q.correct_index, explanation=q.explanation, tags=q.tags)


def write_bundle(db: Session, subject: m.Subject, bundle: Bundle, lesson_id: UUID | None = None) -> dict:
    """Insert a parsed bundle in one transaction. IDs are generated here, so the
    whole nested course is built in memory and flushed in a few batched INSERTs."""
    rows: list = []

    def add_lesson(lesson: Lesson, parent: UUID | None, position: int):
        node = m.RoadmapNode(id=uuid4(), subject_id=subject.id, parent_node_id=parent, order_index=position, title=lesson.title,
                             level=lesson.level, content_markdown=lesson.content)
        rows.append(node)
        rows.extend(question_row(subject.id, node.id, q, i) for i, q in enumerate(lesson.questions))
        for i, child in enumerate(lesson.lessons):
            add_lesson(child, node.id, i)

    # When importing into a lesson, new lessons become its sub-topics.
    root_start = next_position(db, m.RoadmapNode, m.RoadmapNode.subject_id == subject.id, same_parent(m.RoadmapNode.parent_node_id, lesson_id))
    for i, lesson in enumerate(bundle.lessons):
        add_lesson(lesson, lesson_id, root_start + i)

    question_start = next_position(db, m.TestQuestion, m.TestQuestion.subject_id == subject.id, same_parent(m.TestQuestion.node_id, lesson_id))
    rows.extend(question_row(subject.id, lesson_id, q, question_start + i) for i, q in enumerate(bundle.questions))

    for c in bundle.vocabulary:
        rows.append(m.VocabCard(id=uuid4(), subject_id=subject.id, term=c.term, definition=c.definition, part_of_speech=c.part_of_speech,
                                example_sentence=c.example, image_url=c.image_url, audio_url=c.audio_url, tags=c.tags, source="import"))

    reading_start = next_position(db, m.ReadingPassage, m.ReadingPassage.subject_id == subject.id)
    for i, r in enumerate(bundle.readings):
        passage = m.ReadingPassage(id=uuid4(), subject_id=subject.id, order_index=reading_start + i, title=r.title, cefr_level=r.level,
                                   content=r.content, audio_url=r.audio_url)
        rows.append(passage)
        rows.extend(m.ReadingQuestion(id=uuid4(), reading_id=passage.id, order_index=j, prompt=q.prompt, options=q.options,
                                      correct_index=q.correct_index, explanation=q.explanation) for j, q in enumerate(r.questions))
    db.add_all(rows)
    return bundle.counts()


@app.post("/subjects/import", status_code=201)
def import_new_subject(payload: Any = Body(...), db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    """Create a subject from a full course bundle (lessons, questions, vocabulary, readings)."""
    bundle = bundle_or_422(payload)
    if not bundle.title:
        raise HTTPException(422, {"message": "The study material has problems that need fixing", "errors": ['"title": a new subject needs a title']})
    subject = m.Subject(id=uuid4(), owner_user_id=user.id, title=bundle.title, description=bundle.description, target_level=bundle.level)
    db.add(subject)
    db.flush()
    counts = write_bundle(db, subject, bundle)
    commit_or_422(db)
    return {"subject_id": subject.id, "title": subject.title, "imported": counts}


@app.post("/subjects/{subject_id}/import")
def import_into_subject(subject_id: UUID, payload: Any = Body(...), lesson_id: UUID | None = None,
                        db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    """Add material to an existing subject. With ?lesson_id=..., questions are linked to
    that lesson and lessons are added as its sub-topics."""
    subject = require_subject(db, subject_id, user)
    if lesson_id:
        require_item(db, m.RoadmapNode, subject_id, lesson_id, user, "Lesson")
    bundle = bundle_or_422(payload)
    counts = write_bundle(db, subject, bundle, lesson_id)
    commit_or_422(db)
    return {"subject_id": subject.id, "title": subject.title, "imported": counts}


@app.put("/subjects/{subject_id}/content/{part}")
def replace_content(subject_id: UUID, part: str, payload: Any = Body(...), db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    """Replace one part of a subject with edited JSON, in one transaction. part: path (lessons + all
    questions), vocabulary or readings. The old rows go first; their questions, attempts, mistakes,
    progress and reading questions are deleted with them, so nothing stale is left behind."""
    if part not in ("path", "vocabulary", "readings"):
        raise HTTPException(404, "Unknown part")
    subject = require_subject(db, subject_id, user)
    try:
        bundle = parse_bundle(payload)
    except BundleError as e:
        if len(e.errors) == 1 and "nothing to import" in e.errors[0]:
            bundle = Bundle()  # clearing a part on purpose is allowed
        else:
            raise HTTPException(422, {"message": "The study material has problems that need fixing", "errors": e.errors})
    keep = Bundle()
    if part == "path":
        keep.lessons, keep.questions = bundle.lessons, bundle.questions
        db.execute(delete(m.TestQuestion).where(m.TestQuestion.subject_id == subject_id))
        db.execute(delete(m.RoadmapNode).where(m.RoadmapNode.subject_id == subject_id))
    elif part == "vocabulary":
        keep.vocabulary = bundle.vocabulary
        db.execute(delete(m.VocabCard).where(m.VocabCard.subject_id == subject_id))
    else:
        keep.readings = bundle.readings
        db.execute(delete(m.ReadingPassage).where(m.ReadingPassage.subject_id == subject_id))
    db.flush()
    counts = write_bundle(db, subject, keep)
    commit_or_422(db)
    return {"subject_id": subject.id, "saved": counts}


def export_question(prompt, options, answer, explanation="", tags=None) -> dict:
    out = {"question": prompt, "options": options, "answer": answer}
    if explanation:
        out["explanation"] = explanation
    if tags:
        out["tags"] = tags
    return out


def compact(d: dict) -> dict:
    return {k: v for k, v in d.items() if v not in (None, [], "")}


@app.get("/subjects/{subject_id}/export")
def export_bundle(subject_id: UUID, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    """The subject as one ID-free bundle; importing it recreates the same course."""
    s = require_subject(db, subject_id, user)
    nodes = roadmap_rows(db, subject_id)
    tests = test_rows(db, subject_id)
    by_parent, by_node, loose = defaultdict(list), defaultdict(list), []
    for n in nodes:
        by_parent[n.parent_node_id].append(n)
    for t in tests:
        (by_node[t.node_id] if t.node_id else loose).append(t)

    def lesson(n) -> dict:
        return compact({"title": n.title, "level": n.level, "content": n.content_markdown,
                        "questions": [export_question(t.prompt, t.options, t.correct_index, t.explanation, t.tags) for t in by_node[n.id]],
                        "lessons": [lesson(c) for c in by_parent[n.id]]})

    cards = db.scalars(select(m.VocabCard).where(m.VocabCard.subject_id == subject_id).order_by(m.VocabCard.created_at)).all()
    return compact({
        "title": s.title, "description": s.description, "level": s.target_level,
        "lessons": [lesson(n) for n in by_parent[None]],
        "questions": [export_question(t.prompt, t.options, t.correct_index, t.explanation, t.tags) for t in loose],
        "vocabulary": [compact({"term": c.term, "definition": c.definition, "part_of_speech": c.part_of_speech, "example": c.example_sentence,
                                "image_url": c.image_url, "audio_url": c.audio_url, "tags": c.tags}) for c in cards],
        "readings": [compact({"title": r["title"], "level": r["level"], "content": r["passage_markdown"], "audio_url": r["audio_url"],
                              "questions": [export_question(q["prompt"], q["options"], q["correct_index"], q["explanation"]) for q in r["questions"]]})
                     for r in reading_rows(db, subject_id)],
    })
