import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker


DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./promptly.db")
if (
    DATABASE_URL.startswith("sqlite")
    and os.getenv("PUBLIC_BASE_URL")
    and os.getenv("ALLOW_SQLITE_IN_PRODUCTION", "").lower() not in {"1", "true", "yes"}
):
    raise RuntimeError(
        "DATABASE_URL must point to a durable database for public deployments. "
        "Set DATABASE_URL to Postgres/Cloud SQL, or set ALLOW_SQLITE_IN_PRODUCTION=true only for throwaway demos."
    )

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
      yield db
    finally:
      db.close()
