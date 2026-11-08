from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from .config import settings


engine = create_engine(
    settings.database_url,
    # Neon's pooled (PgBouncer) endpoint can break server-side prepared statements.
    connect_args={"prepare_threshold": None},
    pool_pre_ping=True,
    # The browser fires a few requests in parallel; a single pooled connection
    # made them queue behind each other.
    pool_size=5,
    max_overflow=5,
    pool_recycle=300,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
