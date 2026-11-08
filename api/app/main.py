import re
from datetime import datetime, timedelta, timezone
from fastapi import Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import and_, delete, desc, func, select
from sqlalchemy.orm import Session
from .config import settings
from .database import get_db
from . import models as m
from .auth import clear_session_cookie, get_current_user, hash_password, set_session_cookie, verify_password
from .schemas import SubjectIn, NodeIn, TestIn, CardIn, ReadingIn, AttemptIn, ReviewIn, BundleIn, RegisterIn, LoginIn, PasswordChangeIn, AccountDeleteIn

# The schema is managed by Alembic (`alembic upgrade head`); the API no longer
# creates or alters tables at startup.
app = FastAPI(title="OmniLearn API", version="2.0.0", description="Schema-driven learning engine API")
app.add_middleware(CORSMiddleware, allow_origins=settings.allowed_origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
def health(): return {"status": "ok"}


# ---------------------------------------------------------------- helpers

def public_user(user: m.User):
    return {"id": str(user.id), "email": user.email, "full_name": user.full_name}


def dump(obj):
    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns}


def owner_namespace(user: m.User) -> str:
    return "u" + user.id.hex[:8] + "_"


def scoped_subject_id(user: m.User, requested: str | None, title: str) -> str:
    """Subject IDs are global, so the API prefixes them with the owner's namespace."""
    ns = owner_namespace(user)
    slug = (requested or "").strip() or re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_") or "subject"
    if slug.startswith(ns):
        return slug[:64]
    return ns + slug[: 64 - len(ns)]


def require_subject(db: Session, subject_id: str, user: m.User) -> m.Subject:
    subject = db.get(m.Subject, subject_id)
    if not subject or subject.owner_user_id != user.id:
        raise HTTPException(404, "Subject not found")
    return subject


def require_item(db: Session, model, subject_id: str, item_id: str, user: m.User, label: str):
    require_subject(db, subject_id, user)
    obj = db.get(model, (subject_id, item_id))
    if not obj:
        raise HTTPException(404, f"{label} not found")
    return obj


def check_id(payload, item_id: str, label: str):
    if payload.id != item_id:
        raise HTTPException(422, f"{label} ID cannot be changed")


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
    subject_id = scoped_subject_id(user, payload.id, payload.title)
    if db.get(m.Subject, subject_id):
        raise HTTPException(409, "Subject ID already exists")
    obj = m.Subject(id=subject_id, title=payload.title, description=payload.description, target_level=payload.target_level, owner_user_id=user.id)
    db.add(obj); db.commit(); db.refresh(obj)
    return obj


@app.get("/subjects/{subject_id}")
def get_subject(subject_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    return require_subject(db, subject_id, user)


@app.get("/subjects/{subject_id}/dashboard")
def dashboard(subject_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    user_id = str(user.id)
    now = datetime.now(timezone.utc)
    node_count = db.scalar(select(func.count()).select_from(m.RoadmapNode).where(m.RoadmapNode.subject_id == subject_id)) or 0
    completed = db.scalar(select(func.count()).select_from(m.UserNodeProgress).where(
        m.UserNodeProgress.subject_id == subject_id, m.UserNodeProgress.user_id == user_id, m.UserNodeProgress.status == "mastered")) or 0
    due = db.scalar(select(func.count()).select_from(m.UserVocabProgress).where(
        m.UserVocabProgress.subject_id == subject_id, m.UserVocabProgress.user_id == user_id, m.UserVocabProgress.due_date <= now)) or 0
    cards_without_progress = db.scalar(
        select(func.count()).select_from(m.VocabCard).outerjoin(m.UserVocabProgress, and_(
            m.UserVocabProgress.subject_id == m.VocabCard.subject_id,
            m.UserVocabProgress.card_id == m.VocabCard.id,
            m.UserVocabProgress.user_id == user_id,
        )).where(m.VocabCard.subject_id == subject_id, m.UserVocabProgress.id.is_(None))) or 0
    attempts = db.scalars(select(m.UserTestAttempt).where(
        m.UserTestAttempt.user_id == user_id, m.UserTestAttempt.subject_id == subject_id).order_by(desc(m.UserTestAttempt.attempted_at))).all()
    latest = {}
    for attempt in attempts:
        latest.setdefault(attempt.test_id, attempt)
    return {
        "subject_id": subject_id,
        "roadmap_nodes": node_count,
        "roadmap_completed": completed,
        "roadmap_completion_percent": round(completed * 100 / node_count) if node_count else 0,
        "vocab_due": due + cards_without_progress,
        "mistakes": sum(bool(a.is_flagged_mistake) for a in latest.values()),
        "tests": db.scalar(select(func.count()).select_from(m.TestQuestion).where(m.TestQuestion.subject_id == subject_id)) or 0,
        "readings": db.scalar(select(func.count()).select_from(m.ReadingPassage).where(m.ReadingPassage.subject_id == subject_id)) or 0,
    }


@app.get("/subjects/{subject_id}/roadmap")
def get_roadmap(subject_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    return db.scalars(select(m.RoadmapNode).where(m.RoadmapNode.subject_id == subject_id).order_by(m.RoadmapNode.order_index)).all()


@app.get("/subjects/{subject_id}/progress")
def get_subject_progress(subject_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    rows = db.execute(select(m.UserNodeProgress.node_id, m.UserNodeProgress.status).where(
        m.UserNodeProgress.subject_id == subject_id, m.UserNodeProgress.user_id == str(user.id))).all()
    return {node_id: status for node_id, status in rows}


# ---------------------------------------------------------------- roadmap

def link_test(db: Session, subject_id: str, node_id: str, test_id: str):
    node = db.get(m.RoadmapNode, (subject_id, node_id))
    if not node:
        raise HTTPException(404, "Linked node not found")
    node.test_ids = list(dict.fromkeys([*(node.test_ids or []), test_id]))


def unlink_test_from_node(db: Session, subject_id: str, node_id: str | None, test_id: str):
    if not node_id:
        return
    node = db.get(m.RoadmapNode, (subject_id, node_id))
    if node:
        node.test_ids = [x for x in (node.test_ids or []) if x != test_id]


@app.post("/subjects/{subject_id}/nodes", status_code=201)
def create_node(subject_id: str, payload: NodeIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    if db.get(m.RoadmapNode, (subject_id, payload.id)):
        raise HTTPException(409, "Node ID already exists")
    obj = m.RoadmapNode(**payload.model_dump(exclude={"subject_id"}), subject_id=subject_id)
    db.add(obj); db.commit(); db.refresh(obj)
    return obj


@app.put("/subjects/{subject_id}/nodes/{node_id}")
def update_node(subject_id: str, node_id: str, payload: NodeIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    obj = require_item(db, m.RoadmapNode, subject_id, node_id, user, "Node")
    check_id(payload, node_id, "Node")
    for k, v in payload.model_dump(exclude={"id", "subject_id"}).items():
        setattr(obj, k, v)
    db.commit(); db.refresh(obj)
    return obj


@app.delete("/subjects/{subject_id}/nodes/{node_id}", status_code=204)
def delete_node(subject_id: str, node_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    obj = require_item(db, m.RoadmapNode, subject_id, node_id, user, "Node")
    db.delete(obj); db.commit()


@app.delete("/subjects/{subject_id}/nodes/{node_id}/tests/{test_id}")
def unlink_test(subject_id: str, node_id: str, test_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    node = require_item(db, m.RoadmapNode, subject_id, node_id, user, "Node")
    question = db.get(m.TestQuestion, (subject_id, test_id))
    if not question:
        raise HTTPException(404, "Question not found")
    node.test_ids = [x for x in (node.test_ids or []) if x != test_id]
    if question.node_id == node_id:
        question.node_id = None
    db.commit()
    return {"node_id": node_id, "test_id": test_id, "linked": False}


@app.get("/subjects/{subject_id}/nodes/{node_id}/progress")
def get_node_progress(subject_id: str, node_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_item(db, m.RoadmapNode, subject_id, node_id, user, "Node")
    row = db.scalar(select(m.UserNodeProgress).where(
        m.UserNodeProgress.subject_id == subject_id, m.UserNodeProgress.node_id == node_id, m.UserNodeProgress.user_id == str(user.id)))
    return row or {"node_id": node_id, "status": "not_started", "completed_at": None}


@app.post("/subjects/{subject_id}/nodes/{node_id}/progress")
def set_node_progress(subject_id: str, node_id: str, status: str = Query(..., pattern="^(in_progress|mastered)$"), db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_item(db, m.RoadmapNode, subject_id, node_id, user, "Node")
    user_id = str(user.id)
    progress = db.scalar(select(m.UserNodeProgress).where(
        m.UserNodeProgress.subject_id == subject_id, m.UserNodeProgress.node_id == node_id, m.UserNodeProgress.user_id == user_id))
    if not progress:
        progress = m.UserNodeProgress(subject_id=subject_id, node_id=node_id, user_id=user_id)
        db.add(progress)
    progress.status = status
    progress.completed_at = datetime.now(timezone.utc) if status == "mastered" else None
    db.commit(); db.refresh(progress)
    return progress


# ---------------------------------------------------------------- tests

@app.get("/subjects/{subject_id}/tests")
def list_tests(subject_id: str, tag: str | None = None, difficulty: str | None = None, limit: int = Query(100, ge=1, le=500), db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    q = select(m.TestQuestion).where(m.TestQuestion.subject_id == subject_id)
    if tag: q = q.where(m.TestQuestion.tags.contains([tag]))
    if difficulty: q = q.where(m.TestQuestion.tags.contains([f"difficulty:{difficulty}"]))
    return db.scalars(q.limit(limit)).all()


@app.post("/subjects/{subject_id}/tests", status_code=201)
def create_test(subject_id: str, payload: TestIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    if db.get(m.TestQuestion, (subject_id, payload.id)):
        raise HTTPException(409, "Question ID already exists")
    if payload.node_id:
        link_test(db, subject_id, payload.node_id, payload.id)
    obj = m.TestQuestion(**payload.model_dump(exclude={"subject_id"}), subject_id=subject_id)
    db.add(obj); db.commit(); db.refresh(obj)
    return obj


@app.put("/subjects/{subject_id}/tests/{test_id}")
def update_test(subject_id: str, test_id: str, payload: TestIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    obj = require_item(db, m.TestQuestion, subject_id, test_id, user, "Question")
    check_id(payload, test_id, "Question")
    if obj.node_id != payload.node_id:
        unlink_test_from_node(db, subject_id, obj.node_id, test_id)
    if payload.node_id:
        link_test(db, subject_id, payload.node_id, test_id)
    for k, v in payload.model_dump(exclude={"id", "subject_id"}).items():
        setattr(obj, k, v)
    db.commit(); db.refresh(obj)
    return obj


@app.delete("/subjects/{subject_id}/tests/{test_id}", status_code=204)
def delete_test(subject_id: str, test_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    obj = require_item(db, m.TestQuestion, subject_id, test_id, user, "Question")
    unlink_test_from_node(db, subject_id, obj.node_id, test_id)
    db.delete(obj); db.commit()


@app.post("/subjects/{subject_id}/tests/{test_id}/attempts")
def submit_attempt(subject_id: str, test_id: str, payload: AttemptIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    q = require_item(db, m.TestQuestion, subject_id, test_id, user, "Question")
    user_id = str(user.id)
    if payload.selected_index < 0 or payload.selected_index >= len(q.options):
        raise HTTPException(422, "Selected option is out of range")
    prev = db.scalar(select(m.UserTestAttempt).where(
        m.UserTestAttempt.subject_id == subject_id, m.UserTestAttempt.test_id == test_id, m.UserTestAttempt.user_id == user_id,
    ).order_by(desc(m.UserTestAttempt.attempted_at)).limit(1))
    correct = payload.selected_index == q.correct_index
    streak = (prev.consecutive_correct_in_retest if prev and prev.is_flagged_mistake else 0) + 1 if correct else 0
    flagged = (prev.is_flagged_mistake if prev else False) and streak < 2 if correct else True
    db.add(m.UserTestAttempt(subject_id=subject_id, test_id=test_id, user_id=user_id, selected_index=payload.selected_index,
                             is_correct=correct, is_flagged_mistake=flagged, consecutive_correct_in_retest=streak))
    db.commit()
    return {"is_correct": correct, "explanation": q.explanation, "correct_index": q.correct_index, "is_flagged_mistake": flagged, "consecutive_correct_in_retest": streak}


@app.get("/subjects/{subject_id}/mistakes")
def list_mistakes(subject_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    rows = db.execute(
        select(m.UserTestAttempt, m.TestQuestion)
        .join(m.TestQuestion, and_(m.TestQuestion.subject_id == m.UserTestAttempt.subject_id, m.TestQuestion.id == m.UserTestAttempt.test_id))
        .where(m.UserTestAttempt.user_id == str(user.id), m.UserTestAttempt.subject_id == subject_id)
        .order_by(desc(m.UserTestAttempt.attempted_at))
    ).all()
    latest = {}; failures = {}
    for attempt, question in rows:
        failures[question.id] = failures.get(question.id, 0) + (not attempt.is_correct)
        latest.setdefault(question.id, (attempt, question))
    return [{"question": q, "failures": failures[q.id], "streak": a.consecutive_correct_in_retest} for a, q in latest.values() if a.is_flagged_mistake]


# ---------------------------------------------------------------- vocabulary

@app.get("/subjects/{subject_id}/vocab")
def list_vocab(subject_id: str, due_only: bool = False, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    rows = db.execute(
        select(m.VocabCard, m.UserVocabProgress)
        .outerjoin(m.UserVocabProgress, and_(
            m.UserVocabProgress.subject_id == m.VocabCard.subject_id,
            m.UserVocabProgress.card_id == m.VocabCard.id,
            m.UserVocabProgress.user_id == str(user.id),
        ))
        .where(m.VocabCard.subject_id == subject_id)
    ).all()
    now = datetime.now(timezone.utc)
    result = []
    for card, progress in rows:
        is_due = not progress or progress.due_date <= now
        if due_only and not is_due:
            continue
        result.append({**dump(card), "progress": dump(progress) if progress else None, "is_due": is_due})
    return result


@app.post("/subjects/{subject_id}/vocab", status_code=201)
def create_vocab(subject_id: str, payload: CardIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    if db.get(m.VocabCard, (subject_id, payload.id)):
        raise HTTPException(409, "Card ID already exists")
    obj = m.VocabCard(**payload.model_dump(exclude={"subject_id"}), subject_id=subject_id)
    db.add(obj); db.commit(); db.refresh(obj)
    return obj


@app.put("/subjects/{subject_id}/vocab/{card_id}")
def update_vocab(subject_id: str, card_id: str, payload: CardIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    obj = require_item(db, m.VocabCard, subject_id, card_id, user, "Card")
    check_id(payload, card_id, "Card")
    for k, v in payload.model_dump(exclude={"id", "subject_id"}).items():
        setattr(obj, k, v)
    db.commit(); db.refresh(obj)
    return obj


@app.delete("/subjects/{subject_id}/vocab/{card_id}", status_code=204)
def delete_vocab(subject_id: str, card_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    obj = require_item(db, m.VocabCard, subject_id, card_id, user, "Card")
    db.delete(obj); db.commit()


@app.post("/subjects/{subject_id}/vocab/{card_id}/review")
def review_vocab(subject_id: str, card_id: str, payload: ReviewIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_item(db, m.VocabCard, subject_id, card_id, user, "Card")
    user_id = str(user.id)
    p = db.scalar(select(m.UserVocabProgress).where(
        m.UserVocabProgress.subject_id == subject_id, m.UserVocabProgress.card_id == card_id, m.UserVocabProgress.user_id == user_id))
    if not p:
        p = m.UserVocabProgress(subject_id=subject_id, card_id=card_id, user_id=user_id)
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
    db.commit(); db.refresh(p)
    return p


# ---------------------------------------------------------------- readings

def add_reading_questions(db: Session, subject_id: str, reading_id: str, questions):
    for q in questions:
        db.add(m.ReadingQuestion(subject_id=subject_id, reading_id=reading_id, **q.model_dump()))


@app.get("/subjects/{subject_id}/readings")
def list_readings(subject_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    rows = db.execute(
        select(m.ReadingPassage, m.ReadingQuestion)
        .outerjoin(m.ReadingQuestion, and_(m.ReadingQuestion.subject_id == m.ReadingPassage.subject_id, m.ReadingQuestion.reading_id == m.ReadingPassage.id))
        .where(m.ReadingPassage.subject_id == subject_id)
        .order_by(m.ReadingPassage.id, m.ReadingQuestion.order_index)
    ).all()
    grouped = {}
    for passage, question in rows:
        item = grouped.setdefault(passage.id, {"id": passage.id, "subject_id": passage.subject_id, "title": passage.title, "level": passage.cefr_level,
                                               "passage_markdown": passage.content, "audio_url": passage.audio_url, "questions": []})
        if question:
            item["questions"].append(dump(question))
    return list(grouped.values())


@app.post("/subjects/{subject_id}/readings", status_code=201)
def create_reading(subject_id: str, payload: ReadingIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    if db.get(m.ReadingPassage, (subject_id, payload.id)):
        raise HTTPException(409, "Reading ID already exists")
    db.add(m.ReadingPassage(id=payload.id, subject_id=subject_id, title=payload.title, cefr_level=payload.cefr_level, content=payload.content, audio_url=payload.audio_url))
    db.flush()
    add_reading_questions(db, subject_id, payload.id, payload.questions)
    db.commit()
    return {"id": payload.id, "title": payload.title}


@app.put("/subjects/{subject_id}/readings/{reading_id}")
def update_reading(subject_id: str, reading_id: str, payload: ReadingIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    reading = require_item(db, m.ReadingPassage, subject_id, reading_id, user, "Reading")
    check_id(payload, reading_id, "Reading")
    reading.title = payload.title; reading.cefr_level = payload.cefr_level; reading.content = payload.content; reading.audio_url = payload.audio_url
    db.execute(delete(m.ReadingQuestion).where(m.ReadingQuestion.subject_id == subject_id, m.ReadingQuestion.reading_id == reading_id))
    add_reading_questions(db, subject_id, reading_id, payload.questions)
    db.commit()
    return {"id": reading.id, "title": reading.title}


@app.delete("/subjects/{subject_id}/readings/{reading_id}", status_code=204)
def delete_reading(subject_id: str, reading_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    reading = require_item(db, m.ReadingPassage, subject_id, reading_id, user, "Reading")
    db.delete(reading); db.commit()


# ---------------------------------------------------------------- bundles

def upsert(db: Session, model, key: tuple, values: dict):
    row = db.get(model, key)
    if row:
        for k, v in values.items():
            setattr(row, k, v)
    else:
        db.add(model(**values))


@app.post("/subjects/{subject_id}/import")
def import_bundle(subject_id: str, payload: BundleIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    """Import into an owned subject, or create one.

    A new subject's ID is namespaced for this account, so the response's
    `subject_id` may differ from the requested one. Item `subject_id` fields are
    ignored: every item is stored under the resolved subject.
    """
    subject = db.get(m.Subject, subject_id)
    if subject and subject.owner_user_id != user.id:
        subject = None  # someone else's ID: create this account's own subject instead
    if not subject:
        if not payload.subject_title:
            raise HTTPException(422, "subject_title is required for a new subject")
        sid = scoped_subject_id(user, subject_id, payload.subject_title)
        subject = db.get(m.Subject, sid)
        if subject and subject.owner_user_id != user.id:
            raise HTTPException(409, "Subject ID already exists")
        if not subject:
            subject = m.Subject(id=sid, title=payload.subject_title, target_level=payload.target_level, description=payload.description, owner_user_id=user.id)
            db.add(subject); db.flush()
    sid = subject.id

    for node in payload.nodes:
        upsert(db, m.RoadmapNode, (sid, node.id), {**node.model_dump(exclude={"subject_id"}), "subject_id": sid})
    db.flush()  # nodes must exist before tests reference them
    node_ids = set(db.scalars(select(m.RoadmapNode.id).where(m.RoadmapNode.subject_id == sid)))
    for test in payload.tests:
        values = {**test.model_dump(exclude={"subject_id"}), "subject_id": sid}
        if values["node_id"] and values["node_id"] not in node_ids:
            values["node_id"] = None
        upsert(db, m.TestQuestion, (sid, test.id), values)
    for card in payload.cards:
        upsert(db, m.VocabCard, (sid, card.id), {**card.model_dump(exclude={"subject_id"}), "subject_id": sid})
    for reading in payload.readings:
        upsert(db, m.ReadingPassage, (sid, reading.id), {"id": reading.id, "subject_id": sid, "title": reading.title,
                                                         "cefr_level": reading.cefr_level, "content": reading.content, "audio_url": reading.audio_url})
        db.flush()
        for q in reading.questions:
            upsert(db, m.ReadingQuestion, (sid, reading.id, q.id), {**q.model_dump(), "subject_id": sid, "reading_id": reading.id})
    db.commit()
    return {"subject_id": sid, "imported": {"nodes": len(payload.nodes), "tests": len(payload.tests), "cards": len(payload.cards), "readings": len(payload.readings)}}


@app.get("/subjects/{subject_id}/export")
def export_bundle(subject_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    s = require_subject(db, subject_id, user)
    nodes = db.scalars(select(m.RoadmapNode).where(m.RoadmapNode.subject_id == subject_id).order_by(m.RoadmapNode.order_index)).all()
    tests = db.scalars(select(m.TestQuestion).where(m.TestQuestion.subject_id == subject_id)).all()
    cards = db.scalars(select(m.VocabCard).where(m.VocabCard.subject_id == subject_id)).all()
    return {"subject_id": s.id, "subject_title": s.title, "target_level": s.target_level, "description": s.description,
            "nodes": [dump(x) for x in nodes], "tests": [dump(x) for x in tests], "cards": [dump(x) for x in cards],
            "readings": list_readings(subject_id, db, user)}


@app.get("/subjects/{subject_id}/workspace")
def subject_workspace(subject_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    return {
        "roadmap": get_roadmap(subject_id, db, user),
        "tests": list_tests(subject_id, None, None, 100, db, user),
        "cards": list_vocab(subject_id, False, db, user),
        "readings": list_readings(subject_id, db, user),
        "dashboard": dashboard(subject_id, db, user),
        "mistakes": list_mistakes(subject_id, db, user),
        "progress": get_subject_progress(subject_id, db, user),
    }
