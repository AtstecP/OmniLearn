from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field, field_validator


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class SubjectIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=255)
    description: str | None = None
    target_level: str | None = None


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


class NodeIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    subject_id: str
    parent_node_id: str | None = None
    title: str
    level: str | None = None
    order_index: int = 0
    prerequisites: list[str] = []
    content_markdown: str
    test_ids: list[str] = []


class TestIn(BaseModel):
    id: str
    subject_id: str
    node_id: str | None = None
    prompt: str
    options: list[str] = Field(min_length=2)
    correct_index: int
    explanation: str = ""
    tags: list[str] = []

    @field_validator("correct_index")
    @classmethod
    def valid_index(cls, value, info):
        opts = info.data.get("options", [])
        if opts and not 0 <= value < len(opts):
            raise ValueError("correct_index must point to an option")
        return value


class CardIn(BaseModel):
    id: str
    subject_id: str
    term: str
    part_of_speech: str | None = None
    definition: str
    example_sentence: str | None = None
    image_url: str | None = None
    audio_url: str | None = None
    tags: list[str] = []
    source: str = "manual"


class ReadingQuestionIn(BaseModel):
    id: str
    prompt: str
    options: list[str] = Field(min_length=2)
    correct_index: int
    explanation: str = ""
    order_index: int = 0


class ReadingIn(BaseModel):
    id: str
    subject_id: str
    title: str
    cefr_level: str | None = None
    content: str
    audio_url: str | None = None
    questions: list[ReadingQuestionIn] = []


class AttemptIn(BaseModel):
    selected_index: int


class ReviewIn(BaseModel):
    rating: int = Field(ge=0, le=3)


class BundleIn(BaseModel):
    subject_id: str
    subject_title: str | None = None
    target_level: str | None = None
    description: str | None = None
    nodes: list[NodeIn] = []
    tests: list[TestIn] = []
    cards: list[CardIn] = []
    readings: list[ReadingIn] = []
