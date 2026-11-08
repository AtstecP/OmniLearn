from datetime import datetime, timedelta, timezone
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, desc, func, text
from sqlalchemy.orm import Session
from .config import settings
from .database import Base, engine, get_db
from . import models as m
from .auth import create_access_token, get_current_user, hash_password, verify_password
from .schemas import SubjectIn, NodeIn, TestIn, CardIn, ReadingIn, AttemptIn, ReviewIn, BundleIn, RegisterIn, LoginIn, PasswordChangeIn, AccountDeleteIn

Base.metadata.create_all(bind=engine)
with engine.begin() as connection:
    connection.execute(text("ALTER TABLE subjects ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE"))
    connection.execute(text("CREATE INDEX IF NOT EXISTS idx_subject_owner ON subjects(owner_user_id)"))
app = FastAPI(title="OmniLearn API", version="1.0.0", description="Schema-driven learning engine API")
app.add_middleware(CORSMiddleware, allow_origins=settings.allowed_origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
def health(): return {"status": "ok"}


def public_user(user: m.User):
    return {"id": str(user.id), "email": user.email, "full_name": user.full_name}


def auth_result(user: m.User):
    token, expires_in = create_access_token(user)
    return {"access_token": token, "token_type": "bearer", "expires_in": expires_in, "user": public_user(user)}


@app.post("/auth/register", status_code=201)
def register(payload: RegisterIn, db: Session = Depends(get_db)):
    if db.scalar(select(m.User).where(m.User.email == payload.email)):
        raise HTTPException(409, "An account with that email already exists")
    user = m.User(email=payload.email, full_name=payload.full_name.strip(), password_hash=hash_password(payload.password))
    db.add(user)
    db.flush()
    # Preserve subjects created before accounts existed by assigning them to the first account that claims them.
    db.query(m.Subject).filter(m.Subject.owner_user_id.is_(None)).update({m.Subject.owner_user_id: user.id}, synchronize_session=False)
    db.commit()
    db.refresh(user)
    return auth_result(user)


@app.post("/auth/login")
def login(payload: LoginIn, db: Session = Depends(get_db)):
    user = db.scalar(select(m.User).where(m.User.email == payload.email))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(401, "Email or password is incorrect")
    return auth_result(user)


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
def delete_account(payload: AccountDeleteIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(403, "Current password is incorrect")
    if payload.confirmation != "DELETE":
        raise HTTPException(422, "Type DELETE to confirm account reset")
    db.delete(user)
    db.commit()
    return {"status": "account_deleted"}


@app.get("/subjects")
def list_subjects(db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    return db.scalars(select(m.Subject).where(m.Subject.owner_user_id == user.id).order_by(m.Subject.created_at)).all()


@app.post("/subjects", status_code=201)
def create_subject(payload: SubjectIn, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    if db.get(m.Subject, payload.id): raise HTTPException(409, "Subject ID already exists")
    obj=m.Subject(**payload.model_dump(), owner_user_id=user.id); db.add(obj); db.commit(); db.refresh(obj); return obj


@app.get("/subjects/{subject_id}")
def get_subject(subject_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    return require_subject(db, subject_id, user)


@app.get("/subjects/{subject_id}/dashboard")
def dashboard(subject_id: str, db: Session = Depends(get_db), user: m.User = Depends(get_current_user)):
    require_subject(db, subject_id, user)
    user_id = str(user.id)
    nodes=db.scalars(select(m.RoadmapNode).where(m.RoadmapNode.subject_id==subject_id)).all()
    completed=db.scalar(select(func.count()).select_from(m.UserNodeProgress).join(m.RoadmapNode).where(m.RoadmapNode.subject_id==subject_id,m.UserNodeProgress.user_id==user_id,m.UserNodeProgress.status=="mastered")) or 0
    due=db.scalar(select(func.count()).select_from(m.UserVocabProgress).join(m.VocabCard).where(m.VocabCard.subject_id==subject_id,m.UserVocabProgress.user_id==user_id,m.UserVocabProgress.due_date<=datetime.now(timezone.utc))) or 0
    cards_without_progress=db.scalar(select(func.count()).select_from(m.VocabCard).outerjoin(m.UserVocabProgress, (m.VocabCard.id==m.UserVocabProgress.card_id)&(m.UserVocabProgress.user_id==user_id)).where(m.VocabCard.subject_id==subject_id,m.UserVocabProgress.id.is_(None))) or 0
    attempts=db.scalars(select(m.UserTestAttempt).join(m.TestQuestion).where(m.UserTestAttempt.user_id==user_id,m.TestQuestion.subject_id==subject_id).order_by(desc(m.UserTestAttempt.attempted_at))).all()
    latest={}
    for attempt in attempts:latest.setdefault(attempt.test_id,attempt)
    flagged=sum(bool(a.is_flagged_mistake) for a in latest.values())
    node_count=len(nodes)
    return {"subject_id":subject_id,"roadmap_nodes":node_count,"roadmap_completed":completed,"roadmap_completion_percent":round(completed*100/node_count) if node_count else 0,"vocab_due":due+cards_without_progress,"mistakes":flagged,"tests":db.scalar(select(func.count()).select_from(m.TestQuestion).where(m.TestQuestion.subject_id==subject_id)) or 0,"readings":db.scalar(select(func.count()).select_from(m.ReadingPassage).where(m.ReadingPassage.subject_id==subject_id)) or 0}


def require_subject(db, subject_id, user):
    subject = db.get(m.Subject, subject_id)
    if not subject or subject.owner_user_id != user.id:
        raise HTTPException(404, "Subject not found")
    return subject


@app.get("/subjects/{subject_id}/roadmap")
def get_roadmap(subject_id: str, db: Session=Depends(get_db), user: m.User=Depends(get_current_user)):
    require_subject(db,subject_id,user)
    return db.scalars(select(m.RoadmapNode).where(m.RoadmapNode.subject_id==subject_id).order_by(m.RoadmapNode.order_index)).all()


@app.get("/subjects/{subject_id}/progress")
def get_subject_progress(subject_id: str, db: Session=Depends(get_db), user: m.User=Depends(get_current_user)):
    require_subject(db,subject_id,user)
    rows=db.execute(select(m.UserNodeProgress.node_id,m.UserNodeProgress.status).join(m.RoadmapNode,m.RoadmapNode.id==m.UserNodeProgress.node_id).where(m.RoadmapNode.subject_id==subject_id,m.UserNodeProgress.user_id==str(user.id))).all()
    return {node_id:status for node_id,status in rows}


@app.post("/nodes",status_code=201)
def create_node(payload: NodeIn, db: Session=Depends(get_db), user: m.User=Depends(get_current_user)):
    require_subject(db,payload.subject_id,user)
    if db.get(m.RoadmapNode,payload.id): raise HTTPException(409,"Node ID already exists")
    obj=m.RoadmapNode(**payload.model_dump()); db.add(obj); db.commit(); db.refresh(obj); return obj


@app.put("/nodes/{node_id}")
def update_node(node_id: str,payload: NodeIn,db: Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    obj=db.get(m.RoadmapNode,node_id)
    if not obj: raise HTTPException(404,"Node not found")
    if payload.id != node_id or payload.subject_id != obj.subject_id: raise HTTPException(422,"Node ID and subject cannot be changed")
    require_subject(db,obj.subject_id,user)
    require_subject(db,payload.subject_id,user)
    for k,v in payload.model_dump().items(): setattr(obj,k,v)
    db.commit();db.refresh(obj);return obj


@app.delete("/nodes/{node_id}",status_code=204)
def delete_node(node_id: str,db: Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    obj=db.get(m.RoadmapNode,node_id)
    if not obj: raise HTTPException(404,"Node not found")
    require_subject(db,obj.subject_id,user)
    db.delete(obj);db.commit()


@app.delete("/nodes/{node_id}/tests/{test_id}")
def unlink_test(node_id:str,test_id:str,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    node=db.get(m.RoadmapNode,node_id);question=db.get(m.TestQuestion,test_id)
    if not node or not question:raise HTTPException(404,"Node or question not found")
    require_subject(db,node.subject_id,user)
    if question.subject_id != node.subject_id:raise HTTPException(404,"Node or question not found")
    node.test_ids=[x for x in (node.test_ids or []) if x!=test_id]
    if question.node_id==node_id:question.node_id=None
    db.commit();return {"node_id":node_id,"test_id":test_id,"linked":False}


@app.get("/nodes/{node_id}/progress")
def get_node_progress(node_id: str,db: Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    node=db.get(m.RoadmapNode,node_id)
    if not node:raise HTTPException(404,"Node not found")
    require_subject(db,node.subject_id,user)
    user_id=str(user.id)
    rows=db.scalars(select(m.UserNodeProgress).where(m.UserNodeProgress.node_id==node_id,m.UserNodeProgress.user_id==user_id)).all()
    return rows[0] if rows else {"node_id":node_id,"status":"not_started","completed_at":None}


@app.post("/nodes/{node_id}/progress")
def set_node_progress(node_id: str,status: str=Query(...,pattern="^(in_progress|mastered)$"),db: Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    node=db.get(m.RoadmapNode,node_id)
    if not node:raise HTTPException(404,"Node not found")
    require_subject(db,node.subject_id,user)
    user_id=str(user.id)
    progress=db.scalar(select(m.UserNodeProgress).where(m.UserNodeProgress.node_id==node_id,m.UserNodeProgress.user_id==user_id))
    if not progress:progress=m.UserNodeProgress(node_id=node_id,user_id=user_id);db.add(progress)
    progress.status=status;progress.completed_at=datetime.now(timezone.utc) if status=="mastered" else None
    db.commit();db.refresh(progress);return progress


@app.get("/tests")
def list_tests(subject_id: str, tag: str|None=None, difficulty: str|None=None, limit: int=Query(100,ge=1,le=500), db: Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    require_subject(db,subject_id,user)
    q=select(m.TestQuestion).where(m.TestQuestion.subject_id==subject_id)
    if tag:q=q.where(m.TestQuestion.tags.contains([tag]))
    if difficulty:q=q.where(m.TestQuestion.tags.contains([f"difficulty:{difficulty}"]))
    return db.scalars(q.limit(limit)).all()


@app.post("/tests",status_code=201)
def create_test(payload: TestIn,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    require_subject(db,payload.subject_id,user)
    if payload.node_id:
        node=db.get(m.RoadmapNode,payload.node_id)
        if not node or node.subject_id != payload.subject_id: raise HTTPException(404,"Linked node not found")
    if db.get(m.TestQuestion,payload.id): raise HTTPException(409,"Question ID already exists")
    obj=m.TestQuestion(**payload.model_dump());db.add(obj)
    if payload.node_id:
        node=db.get(m.RoadmapNode,payload.node_id);node.test_ids=list(dict.fromkeys([*(node.test_ids or []),payload.id]))
    db.commit();db.refresh(obj);return obj


@app.put("/tests/{test_id}")
def update_test(test_id:str,payload:TestIn,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    obj=db.get(m.TestQuestion,test_id)
    if not obj:raise HTTPException(404,"Question not found")
    if payload.id != test_id or payload.subject_id != obj.subject_id:raise HTTPException(422,"Question ID and subject cannot be changed")
    require_subject(db,obj.subject_id,user)
    require_subject(db,payload.subject_id,user)
    old_node=obj.node_id
    for k,v in payload.model_dump().items():setattr(obj,k,v)
    if old_node and old_node!=payload.node_id:
        previous=db.get(m.RoadmapNode,old_node)
        if previous:previous.test_ids=[x for x in (previous.test_ids or []) if x!=test_id]
    if payload.node_id:
        node=db.get(m.RoadmapNode,payload.node_id)
        if not node or node.subject_id != payload.subject_id:raise HTTPException(404,"Linked node not found")
        node.test_ids=list(dict.fromkeys([*(node.test_ids or []),test_id]))
    db.commit();db.refresh(obj);return obj


@app.delete("/tests/{test_id}",status_code=204)
def delete_test(test_id:str,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    obj=db.get(m.TestQuestion,test_id)
    if not obj:raise HTTPException(404,"Question not found")
    require_subject(db,obj.subject_id,user)
    if obj.node_id:
        node=db.get(m.RoadmapNode,obj.node_id)
        if node:node.test_ids=[x for x in (node.test_ids or []) if x!=test_id]
    db.delete(obj);db.commit()


@app.post("/tests/{test_id}/attempts")
def submit_attempt(test_id:str,payload:AttemptIn,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    q=db.get(m.TestQuestion,test_id)
    if not q:raise HTTPException(404,"Question not found")
    require_subject(db,q.subject_id,user)
    user_id=str(user.id)
    if payload.selected_index<0 or payload.selected_index>=len(q.options):raise HTTPException(422,"Selected option is out of range")
    prev=db.scalar(select(m.UserTestAttempt).where(m.UserTestAttempt.test_id==test_id,m.UserTestAttempt.user_id==user_id).order_by(desc(m.UserTestAttempt.attempted_at)).limit(1))
    correct=payload.selected_index==q.correct_index
    streak=(prev.consecutive_correct_in_retest if prev and prev.is_flagged_mistake else 0)+1 if correct else 0
    flagged=(prev.is_flagged_mistake if prev else False) and streak<2 if correct else True
    attempt=m.UserTestAttempt(test_id=test_id,user_id=user_id,selected_index=payload.selected_index,is_correct=correct,is_flagged_mistake=flagged,consecutive_correct_in_retest=streak)
    db.add(attempt);db.commit()
    return {"is_correct":correct,"explanation":q.explanation,"correct_index":q.correct_index,"is_flagged_mistake":flagged,"consecutive_correct_in_retest":streak}


@app.get("/mistakes")
def list_mistakes(subject_id:str,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    require_subject(db,subject_id,user)
    rows=db.execute(select(m.UserTestAttempt,m.TestQuestion).join(m.TestQuestion).where(m.UserTestAttempt.user_id==str(user.id),m.TestQuestion.subject_id==subject_id).order_by(desc(m.UserTestAttempt.attempted_at))).all()
    latest={};failures={}
    for attempt,question in rows:
        failures[question.id]=failures.get(question.id,0)+(not attempt.is_correct)
        latest.setdefault(question.id,(attempt,question))
    return [{"question":q,"failures":failures[q.id],"streak":a.consecutive_correct_in_retest} for a,q in latest.values() if a.is_flagged_mistake]


@app.get("/vocab")
def list_vocab(subject_id:str,due_only:bool=False,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    require_subject(db,subject_id,user)
    q=select(m.VocabCard,m.UserVocabProgress).outerjoin(m.UserVocabProgress,(m.VocabCard.id==m.UserVocabProgress.card_id)&(m.UserVocabProgress.user_id==str(user.id))).where(m.VocabCard.subject_id==subject_id)
    rows=db.execute(q).all();now=datetime.now(timezone.utc)
    return [{**{c.name:getattr(card,c.name) for c in card.__table__.columns},"progress":({c.name:getattr(progress,c.name) for c in progress.__table__.columns} if progress else None),"is_due":not progress or progress.due_date<=now} for card,progress in rows if not due_only or not progress or progress.due_date<=now]


@app.post("/vocab",status_code=201)
def create_vocab(payload:CardIn,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    require_subject(db,payload.subject_id,user)
    if db.get(m.VocabCard,payload.id):raise HTTPException(409,"Card ID already exists")
    obj=m.VocabCard(**payload.model_dump());db.add(obj);db.commit();db.refresh(obj);return obj


@app.put("/vocab/{card_id}")
def update_vocab(card_id:str,payload:CardIn,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    obj=db.get(m.VocabCard,card_id)
    if not obj:raise HTTPException(404,"Card not found")
    if payload.id != card_id or payload.subject_id != obj.subject_id:raise HTTPException(422,"Card ID and subject cannot be changed")
    require_subject(db,obj.subject_id,user)
    require_subject(db,payload.subject_id,user)
    for k,v in payload.model_dump().items():setattr(obj,k,v)
    db.commit();db.refresh(obj);return obj


@app.delete("/vocab/{card_id}",status_code=204)
def delete_vocab(card_id:str,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    obj=db.get(m.VocabCard,card_id)
    if not obj:raise HTTPException(404,"Card not found")
    require_subject(db,obj.subject_id,user)
    db.delete(obj);db.commit()


@app.post("/vocab/{card_id}/review")
def review_vocab(card_id:str,payload:ReviewIn,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    card=db.get(m.VocabCard,card_id)
    if not card:raise HTTPException(404,"Card not found")
    require_subject(db,card.subject_id,user)
    user_id=str(user.id)
    p=db.scalar(select(m.UserVocabProgress).where(m.UserVocabProgress.card_id==card_id,m.UserVocabProgress.user_id==user_id))
    if not p:p=m.UserVocabProgress(card_id=card_id,user_id=user_id);db.add(p)
    ease=float(p.ease_factor or 2.5);interval=p.interval_days or 0;streak=p.consecutive_correct or 0
    if payload.rating==0:interval=0;streak=0;ease=max(1.3,ease-.2)
    elif payload.rating==1:interval=max(1,round(max(1,interval)*1.2));streak=0;ease=max(1.3,ease-.15)
    elif payload.rating==2:interval=1 if interval<1 else max(2,round(interval*ease));streak+=1
    else:interval=4 if interval<1 else max(4,round(interval*ease*1.3));streak+=1;ease=min(3.2,ease+.15)
    p.interval_days=interval;p.ease_factor=round(ease,2);p.consecutive_correct=streak;p.due_date=datetime.now(timezone.utc)+timedelta(days=interval);p.last_reviewed_at=datetime.now(timezone.utc);p.status="mastered" if interval>=21 else "reviewing" if interval>1 else "learning"
    db.commit();db.refresh(p);return p


@app.get("/readings")
def list_readings(subject_id:str,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    require_subject(db,subject_id,user)
    rows=db.execute(select(m.ReadingPassage,m.ReadingQuestion).outerjoin(m.ReadingQuestion,m.ReadingQuestion.reading_id==m.ReadingPassage.id).where(m.ReadingPassage.subject_id==subject_id).order_by(m.ReadingPassage.id,m.ReadingQuestion.order_index)).all()
    grouped={}
    for passage,question in rows:
        item=grouped.setdefault(passage.id,{"id":passage.id,"subject_id":passage.subject_id,"title":passage.title,"level":passage.cefr_level,"passage_markdown":passage.content,"audio_url":passage.audio_url,"questions":[]})
        if question:item["questions"].append({c.name:getattr(question,c.name) for c in question.__table__.columns})
    return list(grouped.values())


@app.post("/readings",status_code=201)
def create_reading(payload:ReadingIn,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    require_subject(db,payload.subject_id,user)
    if db.get(m.ReadingPassage,payload.id):raise HTTPException(409,"Reading ID already exists")
    reading=m.ReadingPassage(id=payload.id,subject_id=payload.subject_id,title=payload.title,cefr_level=payload.cefr_level,content=payload.content,audio_url=payload.audio_url);db.add(reading)
    for q in payload.questions:db.add(m.ReadingQuestion(reading_id=payload.id,**q.model_dump()))
    db.commit();db.refresh(reading);return {"id":reading.id,"title":reading.title}


@app.put("/readings/{reading_id}")
def update_reading(reading_id:str,payload:ReadingIn,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    reading=db.get(m.ReadingPassage,reading_id)
    if not reading:raise HTTPException(404,"Reading not found")
    require_subject(db,reading.subject_id,user)
    require_subject(db,payload.subject_id,user)
    reading.title=payload.title;reading.cefr_level=payload.cefr_level;reading.content=payload.content;reading.audio_url=payload.audio_url
    for q in db.scalars(select(m.ReadingQuestion).where(m.ReadingQuestion.reading_id==reading_id)).all():db.delete(q)
    for q in payload.questions:db.add(m.ReadingQuestion(reading_id=reading_id,**q.model_dump()))
    db.commit();db.refresh(reading);return {"id":reading.id,"title":reading.title}


@app.delete("/readings/{reading_id}",status_code=204)
def delete_reading(reading_id:str,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    reading=db.get(m.ReadingPassage,reading_id)
    if not reading:raise HTTPException(404,"Reading not found")
    require_subject(db,reading.subject_id,user)
    db.delete(reading);db.commit()


@app.post("/subjects/{subject_id}/import")
def import_bundle(subject_id:str,payload:BundleIn,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    if subject_id!=payload.subject_id:raise HTTPException(422,"Path and payload subject_id must match")
    subject=db.get(m.Subject,subject_id)
    if not subject:
        if not payload.subject_title:raise HTTPException(422,"subject_title is required for a new subject")
        subject=m.Subject(id=subject_id,title=payload.subject_title,target_level=payload.target_level,description=payload.description,owner_user_id=user.id);db.add(subject);db.flush()
    elif subject.owner_user_id != user.id:
        raise HTTPException(404,"Subject not found")
    if any(x.subject_id != subject_id for x in [*payload.nodes,*payload.tests,*payload.cards,*payload.readings]):
        raise HTTPException(422,"Every imported item must belong to the selected subject")
    for node in payload.nodes:
        row=db.get(m.RoadmapNode,node.id)
        if row:
            if row.subject_id != subject_id: raise HTTPException(409,"An imported node ID is already in use")
            for k,v in node.model_dump().items():setattr(row,k,v)
        else:db.add(m.RoadmapNode(**node.model_dump()))
    db.flush()
    for test in payload.tests:
        row=db.get(m.TestQuestion,test.id)
        if row:
            if row.subject_id != subject_id: raise HTTPException(409,"An imported test ID is already in use")
            for k,v in test.model_dump().items():setattr(row,k,v)
        else:db.add(m.TestQuestion(**test.model_dump()))
    for card in payload.cards:
        row=db.get(m.VocabCard,card.id)
        if row:
            if row.subject_id != subject_id: raise HTTPException(409,"An imported card ID is already in use")
            for k,v in card.model_dump().items():setattr(row,k,v)
        else:db.add(m.VocabCard(**card.model_dump()))
    for reading in payload.readings:
        row=db.get(m.ReadingPassage,reading.id)
        if row and row.subject_id != subject_id: raise HTTPException(409,"An imported reading ID is already in use")
        if not row:
            row=m.ReadingPassage(id=reading.id,subject_id=subject_id,title=reading.title,cefr_level=reading.cefr_level,content=reading.content,audio_url=reading.audio_url);db.add(row)
        for q in reading.questions:
            exists=db.get(m.ReadingQuestion,q.id)
            if exists and exists.reading_id != reading.id: raise HTTPException(409,"An imported reading question ID is already in use")
            if not exists:db.add(m.ReadingQuestion(reading_id=reading.id,**q.model_dump()))
    db.commit()
    return {"subject_id":subject_id,"imported":{"nodes":len(payload.nodes),"tests":len(payload.tests),"cards":len(payload.cards),"readings":len(payload.readings)}}


@app.get("/subjects/{subject_id}/export")
def export_bundle(subject_id:str,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    s=db.get(m.Subject,subject_id)
    if not s or s.owner_user_id != user.id:raise HTTPException(404,"Subject not found")
    nodes=db.scalars(select(m.RoadmapNode).where(m.RoadmapNode.subject_id==subject_id).order_by(m.RoadmapNode.order_index)).all()
    tests=db.scalars(select(m.TestQuestion).where(m.TestQuestion.subject_id==subject_id)).all()
    cards=db.scalars(select(m.VocabCard).where(m.VocabCard.subject_id==subject_id)).all()
    readings=list_readings(subject_id,db,user)
    def dump(o):return {c.name:getattr(o,c.name) for c in o.__table__.columns}
    return {"subject_id":s.id,"subject_title":s.title,"target_level":s.target_level,"description":s.description,"nodes":[dump(x) for x in nodes],"tests":[dump(x) for x in tests],"cards":[dump(x) for x in cards],"readings":readings}


@app.get("/subjects/{subject_id}/workspace")
def subject_workspace(subject_id:str,db:Session=Depends(get_db),user: m.User=Depends(get_current_user)):
    require_subject(db,subject_id,user)
    return {
        "roadmap":get_roadmap(subject_id,db,user),
        "tests":list_tests(subject_id,None,None,100,db,user),
        "cards":list_vocab(subject_id,False,db,user),
        "readings":list_readings(subject_id,db,user),
        "dashboard":dashboard(subject_id,db,user),
        "mistakes":list_mistakes(subject_id,db,user),
        "progress":get_subject_progress(subject_id,db,user),
    }
