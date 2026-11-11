"""Request bodies for the small, single-item endpoints.

Bulk study material goes through app/bundle.py instead. No request accepts an
ID for a new item: the server generates every ID. Extra fields (for example an
"id" an older client still sends) are ignored.
"""
from typing import Annotated, Any
from uuid import UUID
from pydantic import AfterValidator, BaseModel, Field, field_validator, model_validator


def _clean_title(value: str) -> str:
    value = (value or "").strip()
    if not value:
        raise ValueError("must not be empty")
    return value


Title = Annotated[str, Field(min_length=1, max_length=255), AfterValidator(_clean_title)]


class SubjectIn(BaseModel):
    title: Title
    description: str | None = Field(default=None, max_length=5000)
    target_level: str | None = Field(default=None, max_length=32)



class ReadingUpdate(BaseModel):
    """Edits one reading text. `questions` (export format) replaces its questions when given."""
    title: Title
    content: str = Field(min_length=1, max_length=200_000)
    level: str | None = Field(default=None, max_length=16)
    questions: list[Any] | None = Field(default=None, max_length=200)


class RegisterIn(BaseModel):
    email: str = Field(min_length=5, max_length=320)
    full_name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=12, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        value = value.strip().lower()
        if "@" not in value or "." not in value.rsplit("@", 1)[-1]:
            raise ValueError("Enter a valid email address")
        return value

    @field_validator("full_name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Enter your name")
        return value


class LoginIn(BaseModel):
    email: str = Field(min_length=5, max_length=320)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.strip().lower()


class PasswordChangeIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=12, max_length=128)


class AccountDeleteIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    confirmation: str


class SubjectDeleteIn(BaseModel):
    confirmation: str = Field(description="The subject's exact title, to confirm deletion")


class NodeCreate(BaseModel):
    title: Title
    content_markdown: str = Field(default="", max_length=200_000)
    level: str | None = Field(default=None, max_length=32)
    parent_node_id: UUID | None = None
    order_index: int | None = Field(default=None, ge=0)



class NodeUpdate(BaseModel):
    """Edits a lesson's text. Moving and reordering go through the layout endpoint."""
    title: Title
    content_markdown: str | None = Field(default=None, max_length=200_000)
    level: str | None = Field(default=None, max_length=32)



class TestCreate(BaseModel):
    node_id: UUID | None = None
    prompt: str = Field(min_length=1, max_length=5000)
    options: list[str] = Field(min_length=2, max_length=20)
    correct_index: int = Field(ge=0)
    explanation: str = Field(default="", max_length=10_000)
    tags: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def check(self):
        self.prompt = _clean_title(self.prompt)
        self.options = [o.strip() for o in self.options]
        if any(not o for o in self.options):
            raise ValueError("options must not be empty")
        if self.correct_index >= len(self.options):
            raise ValueError("correct_index must point to one of the options")
        return self


class CardCreate(BaseModel):
    term: str = Field(min_length=1, max_length=255)
    definition: str = Field(min_length=1, max_length=20_000)
    part_of_speech: str | None = Field(default=None, max_length=64)
    example_sentence: str | None = Field(default=None, max_length=5000)
    image_url: str | None = Field(default=None, max_length=1024)
    audio_url: str | None = Field(default=None, max_length=1024)
    tags: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def check(self):
        self.term = _clean_title(self.term)
        self.definition = _clean_title(self.definition)
        for name in ("image_url", "audio_url"):
            value = getattr(self, name)
            if value is not None and not value.strip().lower().startswith(("http://", "https://")):
                setattr(self, name, None)
        return self


class AttemptIn(BaseModel):
    selected_index: int = Field(ge=0)


class ReviewIn(BaseModel):
    rating: int = Field(ge=0, le=3)


class NodePlacement(BaseModel):
    id: UUID
    parent_node_id: UUID | None = None
    order_index: int = Field(ge=0)


class PhraseIn(BaseModel):
    answer: str = Field(min_length=1, max_length=2000)
    translation: str = Field(default="", max_length=2000)
    audio_url: str | None = Field(default=None, max_length=1024)
    tags: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def check(self):
        self.answer = _clean_title(self.answer)
        self.translation = self.translation.strip()
        if self.audio_url is not None and not self.audio_url.strip().lower().startswith(("http://", "https://")):
            self.audio_url = None
        self.tags = [t.strip()[:64] for t in self.tags if t and t.strip()]
        return self


class BulkIdsIn(BaseModel):
    ids: list[UUID] = Field(max_length=5000)


class RoadmapLayoutIn(BaseModel):
    nodes: list[NodePlacement] = Field(min_length=1, max_length=2000)
