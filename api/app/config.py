from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://omnilearn:omnilearn@db:5432/omnilearn"
    cors_origins: str = "http://localhost:3000"
    jwt_secret: str = "local-only-change-this-jwt-secret-before-deploying-123456"
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
