from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator


# Public, local-only fallback. main.py refuses to start with it when COOKIE_SECURE is on
# (i.e. any HTTPS deployment), so a forgotten JWT_SECRET cannot go live.
DEFAULT_JWT_SECRET = "local-only-change-this-jwt-secret-before-deploying-123456"


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://omnilearn:omnilearn@db:5432/omnilearn"
    cors_origins: str = "http://localhost:3000"
    jwt_secret: str = DEFAULT_JWT_SECRET
    jwt_expire_minutes: int = 1440
    # Session cookie. Keep Secure on for any HTTPS deployment; local Docker over
    # plain http sets COOKIE_SECURE=false.
    cookie_name: str = "omnilearn_session"
    cookie_secure: bool = True
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @field_validator("database_url", mode="before")
    @classmethod
    def add_psycopg_driver(cls, value):
        if isinstance(value, str) and value.startswith("postgresql://"):
            return value.replace("postgresql://", "postgresql+psycopg://", 1)
        return value

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


settings = Settings()
