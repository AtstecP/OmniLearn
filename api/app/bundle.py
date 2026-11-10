"""Learning-bundle format: parse, validate and normalise imported study material.

The canonical format has no IDs. Structure comes from nesting and order:

    {
      "title": "Course title", "description": "...", "level": "Beginner",
      "lessons": [
        {"title": "Main step", "content": "Markdown", "level": "A1",
         "questions": [{"question": "...", "options": ["a", "b"], "answer": 1, "explanation": "..."}],
         "lessons": [ {"title": "Sub-topic", "content": "...", "questions": [...], "lessons": [...]} ]}
      ],
      "questions":  [ ...question-bank questions not tied to a lesson... ],
      "phrases": [ {"answer": "Sentence to listen to and type", "translation": "Shown to the learner", "tags": ["topic"]} ],
      "vocabulary": [ {"term": "...", "definition": "...", "part_of_speech": "...", "example": "...", "tags": ["topic"]} ],
      "readings":   [ {"title": "...", "content": "Markdown", "level": "B1", "questions": [...]} ]
    }

To be forgiving with AI output it also accepts common aliases (nodes, cards,
vocab, passages, children, content_markdown, correct_index, ...), an "answer"
given as the option text or a letter, and the older flat format where lessons
carry their own "id"/"parent_node_id" and tests point at lessons with
"node_id"/"test_ids". Those IDs are used only to rebuild the structure and are
then discarded; the database generates its own.

Every problem is reported with its location, for example
"lessons[2].lessons[0].questions[1].answer: must be one of the 4 options".
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

MAX_ERRORS = 25
MAX_DEPTH = 6
LIMITS = {"lessons": 5000, "questions": 20000, "vocabulary": 30000, "readings": 1000, "phrases": 30000}
TITLE_MAX, LEVEL_MAX, TERM_MAX, POS_MAX, URL_MAX = 255, 32, 255, 64, 1024
TEXT_MAX = 200_000
OPTIONS_MIN, OPTIONS_MAX = 2, 20

# Accepted spellings, first match wins.
K_TITLE = ("title", "name", "subject_title", "course_title", "subject_name", "topic")
K_DESC = ("description", "summary", "about")
K_LEVEL = ("level", "target_level", "cefr_level", "difficulty")
K_LESSONS = ("lessons", "nodes", "roadmap_nodes", "roadmap", "modules", "units", "chapters", "steps", "curriculum", "learning_path")
K_CHILDREN = ("lessons", "children", "subtopics", "sub_topics", "topics", "sub_lessons", "sections", "steps", "nodes")
K_CONTENT = ("content", "content_markdown", "lesson_markdown", "markdown", "body", "text", "lesson", "notes", "explanation")
K_QUESTIONS = ("questions", "tests", "quiz", "quizzes", "test_questions", "checkpoint", "exercises", "test_bank", "question_bank", "assessments")
K_VOCAB = ("vocabulary", "cards", "vocab", "vocab_cards", "vocabulary_cards", "words", "flashcards", "glossary")
K_PHRASES = ("phrases", "dictation", "dictations", "dictation_phrases", "sentences", "listening")
K_PHRASE_ANSWER = ("answer", "text", "phrase", "sentence", "target", "term")
K_PHRASE_SHOWN = ("translation", "meaning", "prompt", "hint", "native", "definition")
K_READINGS = ("readings", "reading_passages", "passages", "reading", "texts")
K_PROMPT = ("question", "prompt", "q", "text", "stem")
K_OPTIONS = ("options", "choices", "answers", "alternatives")
K_ANSWER = ("answer", "correct_index", "correct_answer", "correct", "answer_index", "correct_option", "solution")
K_EXPLAIN = ("explanation", "rationale", "feedback", "why")
K_TAGS = ("tags", "topic", "topics", "category", "categories")
K_TERM = ("term", "word", "phrase", "front", "expression")
K_DEF = ("definition", "meaning", "translation", "back", "gloss")
K_POS = ("part_of_speech", "pos", "word_type")
K_EXAMPLE = ("example", "example_sentence", "sentence", "usage")
K_PASSAGE = ("content", "passage", "passage_markdown", "text", "body", "markdown")
K_ID = ("id", "node_id", "lesson_id", "test_id", "question_id", "key", "slug")
K_PARENT = ("parent_node_id", "parent_id", "parent")
K_LESSON_REF = ("node_id", "lesson_id", "lesson", "parent_node_id")


class BundleError(Exception):
    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("; ".join(errors))


@dataclass
class Question:
    prompt: str
    options: list[str]
    correct_index: int
    explanation: str = ""
    tags: list[str] = field(default_factory=list)


@dataclass
class Lesson:
    title: str
    content: str = ""
    level: str | None = None
    questions: list[Question] = field(default_factory=list)
    lessons: list["Lesson"] = field(default_factory=list)


@dataclass
class Card:
    term: str
    definition: str
    part_of_speech: str | None = None
    example: str | None = None
    image_url: str | None = None
    audio_url: str | None = None
    tags: list[str] = field(default_factory=list)


@dataclass
class Phrase:
    answer: str
    translation: str = ""
    audio_url: str | None = None
    tags: list[str] = field(default_factory=list)


@dataclass
class Reading:
    title: str
    content: str
    level: str | None = None
    audio_url: str | None = None
    questions: list[Question] = field(default_factory=list)


@dataclass
class Bundle:
    title: str | None = None
    description: str | None = None
    level: str | None = None
    lessons: list[Lesson] = field(default_factory=list)
    questions: list[Question] = field(default_factory=list)
    vocabulary: list[Card] = field(default_factory=list)
    readings: list[Reading] = field(default_factory=list)
    phrases: list[Phrase] = field(default_factory=list)

    def counts(self) -> dict[str, int]:
        lessons = questions = 0
        stack = list(self.lessons)
        while stack:
            lesson = stack.pop()
            lessons += 1
            questions += len(lesson.questions)
            stack.extend(lesson.lessons)
        return {
            "lessons": lessons,
            "questions": questions + len(self.questions),
            "vocabulary": len(self.vocabulary),
            "readings": len(self.readings),
            "phrases": len(self.phrases),
            "reading_questions": sum(len(r.questions) for r in self.readings),
        }

    def is_empty(self) -> bool:
        return not (self.lessons or self.questions or self.vocabulary or self.readings or self.phrases)


class _Parser:
    def __init__(self):
        self.errors: list[str] = []

    # ---------------------------------------------------------------- helpers
    def err(self, path: str, message: str):
        if len(self.errors) < MAX_ERRORS:
            self.errors.append(f"{path}: {message}" if path else message)

    @staticmethod
    def pick(obj: dict, keys: tuple[str, ...]) -> tuple[str | None, Any]:
        for key in keys:
            if key in obj and obj[key] is not None:
                return key, obj[key]
        return None, None

    def text(self, obj: dict, keys, path: str, *, required=False, max_len=TEXT_MAX, label=None) -> str | None:
        key, value = self.pick(obj, keys)
        name = label or keys[0]
        if value is None or (isinstance(value, str) and not value.strip()):
            if required:
                self.err(path, f'"{name}" is required')
            return None
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            value = str(value)
        if isinstance(value, list) and all(isinstance(v, str) for v in value):
            value = "\n\n".join(value)  # paragraphs given as a list
        if not isinstance(value, str):
            self.err(f"{path}.{key}", "must be text")
            return None
        value = value.strip()
        if len(value) > max_len:
            self.err(f"{path}.{key}", f"is too long ({len(value)} characters, max {max_len})")
            return None
        return value

    def short(self, obj, keys, path, max_len) -> str | None:
        value = self.text(obj, keys, path)
        if value and len(value) > max_len:
            value = value[:max_len].rstrip()
        return value

    def url(self, obj, keys, path) -> str | None:
        value = self.text(obj, keys, path, max_len=URL_MAX)
        if value and not re.match(r"^https?://", value, re.I):
            return None  # silently drop non-web links (data:, javascript:, local paths)
        return value

    def tags(self, obj, path) -> list[str]:
        _, value = self.pick(obj, K_TAGS)
        if value is None:
            return []
        if isinstance(value, str):
            value = [part for part in re.split(r"[,;]", value)]
        if not isinstance(value, list):
            return []
        out = []
        for tag in value:
            if isinstance(tag, (str, int, float)) and str(tag).strip():
                t = str(tag).strip()[:64]
                if t not in out:
                    out.append(t)
        return out[:20]

    def items(self, obj: dict, keys, path: str, *, nested_key: str | None = None) -> tuple[str, list]:
        """Find a list under any alias; also accepts {"questions": [...]}-style wrappers."""
        key, value = self.pick(obj, keys)
        if value is None:
            return "", []
        if isinstance(value, dict):
            inner_key, inner = self.pick(value, (nested_key,) + keys if nested_key else keys)
            if isinstance(inner, list):
                return f"{key}.{inner_key}", inner
            return key, [value]  # a single object instead of a list
        if not isinstance(value, list):
            self.err(f"{path}{'.' if path else ''}{key}", "must be a list")
            return key, []
        return key, value

    # ---------------------------------------------------------------- pieces
    def question(self, raw: Any, path: str) -> Question | None:
        if not isinstance(raw, dict):
            self.err(path, "must be an object with a question and options")
            return None
        prompt = self.text(raw, K_PROMPT, path, required=True, label="question")
        okey, options = self.pick(raw, K_OPTIONS)
        clean: list[str] = []
        if isinstance(options, dict):  # {"A": "...", "B": "..."}
            options = [options[k] for k in sorted(options)]
        if not isinstance(options, list):
            self.err(path, f'"options" must be a list of {OPTIONS_MIN}-{OPTIONS_MAX} answers')
        else:
            for i, opt in enumerate(options):
                if isinstance(opt, dict):
                    opt = self.pick(opt, ("text", "option", "label", "value"))[1]
                if isinstance(opt, (int, float)) and not isinstance(opt, bool):
                    opt = str(opt)
                if not isinstance(opt, str) or not opt.strip():
                    self.err(f"{path}.{okey}[{i}]", "must be non-empty text")
                    continue
                clean.append(opt.strip()[:2000])
            if not OPTIONS_MIN <= len(clean) <= OPTIONS_MAX:
                self.err(f"{path}.{okey}", f"needs {OPTIONS_MIN}-{OPTIONS_MAX} options (found {len(clean)})")
        akey, answer = self.pick(raw, K_ANSWER)
        index = self.answer_index(answer, clean, f"{path}.{akey or 'answer'}")
        if prompt is None or index is None or not OPTIONS_MIN <= len(clean) <= OPTIONS_MAX:
            return None
        return Question(prompt=prompt[:5000], options=clean, correct_index=index,
                        explanation=(self.text(raw, K_EXPLAIN, path, max_len=10_000) or ""), tags=self.tags(raw, path))

    def answer_index(self, answer: Any, options: list[str], path: str) -> int | None:
        if answer is None:
            self.err(path, '"answer" is required (the zero-based index of the correct option, or its exact text)')
            return None
        if isinstance(answer, bool):
            self.err(path, "must be an option index or the option text")
            return None
        if isinstance(answer, float) and answer.is_integer():
            answer = int(answer)
        if isinstance(answer, int):
            if 0 <= answer < len(options):
                return answer
            self.err(path, f"index {answer} is outside the {len(options)} options (use 0 for the first option)")
            return None
        if isinstance(answer, str):
            wanted = answer.strip()
            for i, opt in enumerate(options):
                if opt.strip().casefold() == wanted.casefold():
                    return i
            if wanted.isdigit() and 0 <= int(wanted) < len(options):
                return int(wanted)
            letter = re.fullmatch(r"\(?([A-Za-z])[).]?", wanted)
            if letter:
                i = ord(letter.group(1).upper()) - 65
                if 0 <= i < len(options):
                    return i
            self.err(path, f'"{wanted[:60]}" does not match any of the {len(options)} options')
            return None
        self.err(path, "must be an option index or the option text")
        return None

    def questions(self, obj: dict, path: str) -> list[Question]:
        key, raw = self.items(obj, K_QUESTIONS, path, nested_key="questions")
        out = []
        for i, item in enumerate(raw):
            q = self.question(item, f"{path}{'.' if path else ''}{key}[{i}]")
            if q:
                out.append(q)
        return out

    def lesson(self, raw: Any, path: str, depth: int) -> Lesson | None:
        if isinstance(raw, str) and raw.strip():
            return Lesson(title=raw.strip()[:TITLE_MAX])  # a bare title
        if not isinstance(raw, dict):
            self.err(path, "must be an object with a title")
            return None
        title = self.text(raw, K_TITLE, path, required=True, max_len=TITLE_MAX)
        content = self.text(raw, K_CONTENT, path) or ""
        lesson = Lesson(title=title or "", content=content, level=self.short(raw, K_LEVEL, path, LEVEL_MAX),
                        questions=self.questions(raw, path))
        key, children = self.items(raw, K_CHILDREN, path)
        if children:
            if depth >= MAX_DEPTH:
                self.err(f"{path}.{key}", f"lessons can be nested at most {MAX_DEPTH} levels deep")
            else:
                for i, child in enumerate(children):
                    c = self.lesson(child, f"{path}.{key}[{i}]", depth + 1)
                    if c:
                        lesson.lessons.append(c)
        return lesson if title else None

    def card(self, raw: Any, path: str) -> Card | None:
        if not isinstance(raw, dict):
            self.err(path, "must be an object with a term and definition")
            return None
        term = self.text(raw, K_TERM, path, required=True, max_len=TERM_MAX, label="term")
        definition = self.text(raw, K_DEF, path, required=True, label="definition")
        if not term or not definition:
            return None
        return Card(term=term, definition=definition, part_of_speech=self.short(raw, K_POS, path, POS_MAX),
                    example=self.text(raw, K_EXAMPLE, path, max_len=5000), image_url=self.url(raw, ("image_url", "image"), path),
                    audio_url=self.url(raw, ("audio_url", "audio"), path), tags=self.tags(raw, path))

    def phrase(self, raw: Any, path: str) -> Phrase | None:
        if not isinstance(raw, dict):
            self.err(path, "must be an object with the phrase (answer) and its translation")
            return None
        answer = self.text(raw, K_PHRASE_ANSWER, path, required=True, max_len=2000, label="answer")
        if not answer:
            return None
        shown = self.text(raw, K_PHRASE_SHOWN, path, max_len=2000) or ""
        return Phrase(answer=answer, translation=shown, audio_url=self.url(raw, ("audio_url", "audio"), path), tags=self.tags(raw, path))

    def reading(self, raw: Any, path: str) -> Reading | None:
        if not isinstance(raw, dict):
            self.err(path, "must be an object with a title and content")
            return None
        title = self.text(raw, K_TITLE, path, required=True, max_len=TITLE_MAX)
        content = self.text(raw, K_PASSAGE, path, required=True, label="content")
        questions = self.questions(raw, path)
        if not title or not content:
            return None
        return Reading(title=title, content=content, level=self.short(raw, K_LEVEL, path, 16),
                       audio_url=self.url(raw, ("audio_url", "audio"), path), questions=questions)

    # ---------------------------------------------------------------- flat (older) format
    def flat_lessons(self, raw: list, key: str) -> tuple[list[Lesson], dict[str, Lesson]]:
        """Lessons given as a flat list with id + parent id: rebuild the tree."""
        by_id: dict[str, Lesson] = {}
        parents: dict[str, str | None] = {}
        order: list[tuple[str | None, Lesson]] = []
        for i, item in enumerate(raw):
            path = f"{key}[{i}]"
            lesson = self.lesson({k: v for k, v in item.items() if k not in K_CHILDREN} if isinstance(item, dict) else item, path, 1)
            if not lesson:
                continue
            ref = None
            if isinstance(item, dict):
                _, ident = self.pick(item, K_ID)
                ref = str(ident) if ident is not None else None
                _, parent = self.pick(item, K_PARENT)
                if ref:
                    by_id[ref] = lesson
                    parents[ref] = str(parent) if parent not in (None, "") else None
            order.append((ref, lesson))
        roots: list[Lesson] = []
        for ref, lesson in order:
            parent = parents.get(ref) if ref else None
            # Walk up to make sure the parent exists and there is no cycle.
            seen, cur = {ref}, parent
            while cur is not None and cur in by_id and cur not in seen:
                seen.add(cur)
                cur = parents.get(cur)
            if parent and parent in by_id and cur is None:
                by_id[parent].lessons.append(lesson)
            else:
                roots.append(lesson)
        return roots, by_id

    # ---------------------------------------------------------------- top level
    def bundle(self, raw: Any) -> Bundle:
        if isinstance(raw, list):
            self.err("", 'the JSON must be an object such as {"title": ..., "lessons": [...]} , not a list')
            return Bundle()
        if not isinstance(raw, dict):
            self.err("", "the JSON must be an object")
            return Bundle()
        # Unwrap {"course": {...}} / {"bundle": {...}} style envelopes.
        if len(raw) == 1:
            only = next(iter(raw.values()))
            if isinstance(only, dict) and any(k in only for k in K_LESSONS + K_VOCAB + K_READINGS + K_QUESTIONS + K_PHRASES):
                raw = only

        bundle = Bundle(title=self.text(raw, K_TITLE, "", max_len=TITLE_MAX), description=self.text(raw, K_DESC, "", max_len=5000),
                        level=self.short(raw, K_LEVEL, "", LEVEL_MAX))

        lkey, lessons_raw = self.items(raw, K_LESSONS, "", nested_key="lessons")
        flat = any(isinstance(x, dict) and self.pick(x, K_PARENT)[1] not in (None, "") for x in lessons_raw)
        lessons_by_id: dict[str, Lesson] = {}
        if flat:
            bundle.lessons, lessons_by_id = self.flat_lessons(lessons_raw, lkey)
        else:
            for i, item in enumerate(lessons_raw):
                lesson = self.lesson(item, f"{lkey}[{i}]", 1)
                if lesson:
                    bundle.lessons.append(lesson)
                if isinstance(item, dict) and self.pick(item, K_ID)[1] is not None:
                    lessons_by_id.setdefault(str(self.pick(item, K_ID)[1]), lesson) if lesson else None

        # Top-level questions; older bundles link them to lessons by id.
        qkey, questions_raw = self.items(raw, K_QUESTIONS, "", nested_key="questions")
        claimed_by_lesson: dict[str, Lesson] = {}
        for item in lessons_raw:
            if isinstance(item, dict):
                _, ident = self.pick(item, K_ID)
                tests = item.get("test_ids")
                if ident is not None and isinstance(tests, list) and str(ident) in lessons_by_id:
                    for t in tests:
                        ref = t.get("id") if isinstance(t, dict) else t
                        if ref is not None:
                            claimed_by_lesson[str(ref)] = lessons_by_id[str(ident)]
        for i, item in enumerate(questions_raw):
            q = self.question(item, f"{qkey}[{i}]")
            if not q:
                continue
            target = None
            if isinstance(item, dict):
                _, lesson_ref = self.pick(item, K_LESSON_REF)
                if lesson_ref is not None and str(lesson_ref) in lessons_by_id:
                    target = lessons_by_id[str(lesson_ref)]
                elif self.pick(item, K_ID)[1] is not None:
                    target = claimed_by_lesson.get(str(self.pick(item, K_ID)[1]))
            (target.questions if target else bundle.questions).append(q)

        vkey, vocab_raw = self.items(raw, K_VOCAB, "", nested_key="cards")
        for i, item in enumerate(vocab_raw):
            c = self.card(item, f"{vkey}[{i}]")
            if c:
                bundle.vocabulary.append(c)

        rkey, readings_raw = self.items(raw, K_READINGS, "", nested_key="passages")
        for i, item in enumerate(readings_raw):
            r = self.reading(item, f"{rkey}[{i}]")
            if r:
                bundle.readings.append(r)

        pkey, phrases_raw = self.items(raw, K_PHRASES, "", nested_key="phrases")
        for i, item in enumerate(phrases_raw):
            p = self.phrase(item, f"{pkey}[{i}]")
            if p:
                bundle.phrases.append(p)

        counts = bundle.counts()
        for name, limit in LIMITS.items():
            if counts[name] > limit:
                self.err(name, f"too many items ({counts[name]}, max {limit} per import)")
        if not self.errors and bundle.is_empty():
            self.err("", "nothing to import: add lessons, questions, vocabulary, readings or phrases")
        return bundle


def parse_bundle(raw: Any) -> Bundle:
    parser = _Parser()
    bundle = parser.bundle(raw)
    if parser.errors:
        raise BundleError(parser.errors)
    return bundle


def parse_question(raw: Any) -> Question:
    parser = _Parser()
    q = parser.question(raw, "question")
    if parser.errors or q is None:
        raise BundleError(parser.errors or ["question: invalid"])
    return q
