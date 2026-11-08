from datetime import datetime, timezone
from uuid import UUID as PythonUUID, uuid4
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column
from .database import Base


def now_utc():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id: Mapped[PythonUUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    full_name: Mapped[str] = mapped_column(String(120), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Subject(Base):
    __tablename__ = "subjects"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    target_level: Mapped[str | None] = mapped_column(String(32))
    owner_user_id: Mapped[PythonUUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class RoadmapNode(Base):
    __tablename__ = "roadmap_nodes"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    subject_id: Mapped[str] = mapped_column(ForeignKey("subjects.id", ondelete="CASCADE"), nullable=False, index=True)
    parent_node_id: Mapped[str | None] = mapped_column(ForeignKey("roadmap_nodes.id", ondelete="SET NULL"))
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    level: Mapped[str | None] = mapped_column(String(32))
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    prerequisites: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    content_markdown: Mapped[str] = mapped_column(Text, nullable=False)
    test_ids: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class UserNodeProgress(Base):
    __tablename__ = "user_node_progress"
    __table_args__ = (UniqueConstraint("user_id", "node_id", name="uq_user_node"),)
    id: Mapped[object] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    node_id: Mapped[str] = mapped_column(ForeignKey("roadmap_nodes.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="in_progress")
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TestQuestion(Base):
    __tablename__ = "tests"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    subject_id: Mapped[str] = mapped_column(ForeignKey("subjects.id", ondelete="CASCADE"), nullable=False, index=True)
    node_id: Mapped[str | None] = mapped_column(ForeignKey("roadmap_nodes.id", ondelete="SET NULL"), index=True)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    options: Mapped[list] = mapped_column(JSONB, nullable=False)
    correct_index: Mapped[int] = mapped_column(Integer, nullable=False)
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class VocabCard(Base):
    __tablename__ = "vocab_cards"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    subject_id: Mapped[str] = mapped_column(ForeignKey("subjects.id", ondelete="CASCADE"), nullable=False, index=True)
    term: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    part_of_speech: Mapped[str | None] = mapped_column(String(64))
    definition: Mapped[str] = mapped_column(Text, nullable=False)
    example_sentence: Mapped[str | None] = mapped_column(Text)
    image_url: Mapped[str | None] = mapped_column(String(1024))
    audio_url: Mapped[str | None] = mapped_column(String(1024))
    tags: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    source: Mapped[str] = mapped_column(String(64), default="manual")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserVocabProgress(Base):
    __tablename__ = "user_vocab_progress"
    __table_args__ = (UniqueConstraint("user_id", "card_id", name="uq_user_card"),)
    id: Mapped[object] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    card_id: Mapped[str] = mapped_column(ForeignKey("vocab_cards.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    interval_days: Mapped[int] = mapped_column(Integer, default=1)
    ease_factor: Mapped[float] = mapped_column(Numeric(4, 2), default=2.5)
    consecutive_correct: Mapped[int] = mapped_column(Integer, default=0)
    due_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    last_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(32), default="learning")


class UserTestAttempt(Base):
    __tablename__ = "user_test_attempts"
    id: Mapped[object] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    test_id: Mapped[str] = mapped_column(ForeignKey("tests.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    selected_index: Mapped[int] = mapped_column(Integer, nullable=False)
    is_correct: Mapped[bool] = mapped_column(Boolean, nullable=False)
    is_flagged_mistake: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    consecutive_correct_in_retest: Mapped[int] = mapped_column(Integer, default=0)
    attempted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ReadingPassage(Base):
    __tablename__ = "reading_passages"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    subject_id: Mapped[str] = mapped_column(ForeignKey("subjects.id", ondelete="CASCADE"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    cefr_level: Mapped[str | None] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text, nullable=False)
    audio_url: Mapped[str | None] = mapped_column(String(1024))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ReadingQuestion(Base):
    __tablename__ = "reading_questions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    reading_id: Mapped[str] = mapped_column(ForeignKey("reading_passages.id", ondelete="CASCADE"), nullable=False, index=True)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    options: Mapped[list] = mapped_column(JSONB, nullable=False)
    correct_index: Mapped[int] = mapped_column(Integer, nullable=False)
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
