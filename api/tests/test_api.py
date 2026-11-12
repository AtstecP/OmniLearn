import gzip
import json

from fastapi.testclient import TestClient

from conftest import BUNDLE, PASSWORD, import_subject, new_client, q


# ------------------------------------------------------------------ accounts

def test_health(app):
    assert TestClient(app).get("/health").json() == {"status": "ok"}


def test_register_login_me_logout(app):
    c = TestClient(app, base_url="http://testserver")
    email = "auth-flow@test.dev"
    assert c.post("/auth/register", json={"email": email, "full_name": "A", "password": PASSWORD}).status_code in (201, 409)
    assert c.post("/auth/login", json={"email": email, "password": "wrong-password-123"}).status_code == 401
    r = c.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200 and "token" not in r.text  # the token lives in an httpOnly cookie only
    assert c.get("/auth/me").json()["email"] == email
    c.post("/auth/logout")
    assert c.get("/auth/me").status_code == 401


def test_short_password_rejected(app):
    r = TestClient(app).post("/auth/register", json={"email": "short@test.dev", "full_name": "S", "password": "short"})
    assert r.status_code == 422


def test_protected_routes_need_a_session(app):
    anon = TestClient(app)
    for path in ("/subjects", "/activity", "/subjects/00000000-0000-0000-0000-000000000000/workspace"):
        assert anon.get(path).status_code == 401, path


# ------------------------------------------------------------------ import / export

def test_import_counts_and_workspace(course):
    c, sid = course
    w = c.get(f"/subjects/{sid}/workspace").json()
    assert len(w["roadmap"]) == 4                      # Greetings, Formal, Informal, Food
    assert len(w["tests"]) == 5                        # Q1-Q4 and the loose question
    assert len(w["cards"]) == 4 and len(w["phrases"]) == 3 and len(w["readings"]) == 1
    assert [n["title"] for n in w["roadmap"]] == ["Greetings", "Formal", "Informal", "Food"]  # depth first
    formal = next(n for n in w["roadmap"] if n["title"] == "Formal")
    assert formal["parent_node_id"] == next(n for n in w["roadmap"] if n["title"] == "Greetings")["id"]


def test_import_response_reports_counts(alice):
    r = alice.post("/subjects/import", json=BUNDLE).json()
    assert r["imported"]["lessons"] == 4 and r["imported"]["phrases"] == 3 and r["imported"]["vocabulary"] == 4


def test_export_round_trip(course):
    c, sid = course
    exported = c.get(f"/subjects/{sid}/export").json()
    sid2 = import_subject(c, exported)
    a, b = c.get(f"/subjects/{sid}/workspace").json(), c.get(f"/subjects/{sid2}/workspace").json()
    for key in ("roadmap", "tests", "cards", "readings", "phrases"):
        assert len(a[key]) == len(b[key]), key
    assert [n["title"] for n in a["roadmap"]] == [n["title"] for n in b["roadmap"]]


def test_bad_import_saves_nothing(alice):
    before = len(alice.get("/subjects").json())
    bad = {"title": "Broken", "lessons": [{"title": "L", "content": "x", "questions": [{"question": "?", "options": ["a", "b"], "answer": 9}]}]}
    r = alice.post("/subjects/import", json=bad)
    assert r.status_code == 422 and r.json()["detail"]["errors"]
    assert len(alice.get("/subjects").json()) == before


def test_import_into_existing_subject_adds(course):
    c, sid = course
    r = c.post(f"/subjects/{sid}/import", json={"vocabulary": [{"term": "chat", "definition": "cat"}]})
    assert r.status_code in (200, 201)
    assert len(c.get(f"/subjects/{sid}/workspace").json()["cards"]) == 5


def test_gzipped_request_body_is_accepted(alice):
    raw = gzip.compress(json.dumps(BUNDLE).encode())
    r = alice.post("/subjects/import", content=raw, headers={"Content-Type": "application/json", "Content-Encoding": "gzip"})
    assert r.status_code in (200, 201), r.text


def test_responses_are_gzipped_when_large(course):
    c, sid = course
    r = c.get(f"/subjects/{sid}/workspace", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers.get("content-encoding") == "gzip"


# ------------------------------------------------------------------ lean workspace

def test_workspace_leaves_out_heavy_text(course):
    c, sid = course
    w = c.get(f"/subjects/{sid}/workspace").json()
    assert all("content_markdown" not in n for n in w["roadmap"])
    assert "passage_markdown" not in w["readings"][0] and w["readings"][0]["question_count"] == 2


def test_single_lesson_and_reading_have_their_text(course):
    c, sid = course
    w = c.get(f"/subjects/{sid}/workspace").json()
    node = c.get(f"/subjects/{sid}/nodes/{w['roadmap'][0]['id']}").json()
    assert "Bonjour means hello" in node["content_markdown"]
    reading = c.get(f"/subjects/{sid}/readings/{w['readings'][0]['id']}").json()
    assert "café" in reading["passage_markdown"] and len(reading["questions"]) == 2


def test_rename_keeps_lesson_text(course):
    c, sid = course
    nid = c.get(f"/subjects/{sid}/workspace").json()["roadmap"][0]["id"]
    assert c.put(f"/subjects/{sid}/nodes/{nid}", json={"title": "Renamed"}).status_code == 200
    node = c.get(f"/subjects/{sid}/nodes/{nid}").json()
    assert node["title"] == "Renamed" and "Bonjour means hello" in node["content_markdown"]
    assert c.put(f"/subjects/{sid}/nodes/{nid}", json={"title": "Renamed", "content_markdown": "new text"}).status_code == 200
    assert c.get(f"/subjects/{sid}/nodes/{nid}").json()["content_markdown"] == "new text"


def test_search_finds_lesson_text(course):
    c, sid = course
    w = c.get(f"/subjects/{sid}/workspace").json()
    ids = c.get(f"/subjects/{sid}/roadmap/search", params={"q": "unicorn"}).json()
    assert ids == [w["roadmap"][0]["id"]]
    assert c.get(f"/subjects/{sid}/roadmap/search", params={"q": "zzzzzz"}).json() == []
    assert c.get(f"/subjects/{sid}/roadmap/search", params={"q": "%"}).json() == []  # % is a literal, not a wildcard


# ------------------------------------------------------------------ replace one part / one topic

def cards(c, sid):
    return sorted((x["term"], tuple(x["tags"])) for x in c.get(f"/subjects/{sid}/workspace").json()["cards"])


def phrases(c, sid):
    return sorted(x["answer"] for x in c.get(f"/subjects/{sid}/workspace").json()["phrases"])


def test_replace_vocabulary_topic_only_touches_that_topic(course):
    c, sid = course
    r = c.put(f"/subjects/{sid}/content/vocabulary", params={"topic": "greetings"},
              json={"vocabulary": [{"term": "salut", "definition": "hi", "tags": ["greetings"]}]})
    assert r.status_code == 200
    assert cards(c, sid) == [("eau", ()), ("pain", ("food",)), ("salut", ("greetings",))]


def test_replace_vocabulary_general_topic_means_untagged(course):
    c, sid = course
    assert c.put(f"/subjects/{sid}/content/vocabulary", params={"topic": "General"}, json={"vocabulary": []}).status_code == 200
    assert [t for t, _ in cards(c, sid)] == ["bonjour", "merci", "pain"]


def test_delete_whole_block_with_empty_list(course):
    c, sid = course
    assert c.put(f"/subjects/{sid}/content/vocabulary", params={"topic": "food"}, json={"vocabulary": []}).status_code == 200
    assert [t for t, _ in cards(c, sid)] == ["bonjour", "eau", "merci"]


def test_replace_all_vocabulary(course):
    c, sid = course
    assert c.put(f"/subjects/{sid}/content/vocabulary", json={"vocabulary": [{"term": "un", "definition": "one"}]}).status_code == 200
    assert cards(c, sid) == [("un", ())]


def test_replace_phrases_topic_and_edit_and_delete(course):
    c, sid = course
    r = c.put(f"/subjects/{sid}/content/phrases", params={"topic": "food"},
              json={"phrases": [{"answer": "Une baguette.", "translation": "A baguette.", "tags": ["food"]}]})
    assert r.status_code == 200
    assert phrases(c, sid) == ["Bonjour, comment allez-vous ?", "Merci beaucoup.", "Une baguette."]
    pid = next(p["id"] for p in c.get(f"/subjects/{sid}/workspace").json()["phrases"] if p["answer"] == "Merci beaucoup.")
    assert c.put(f"/subjects/{sid}/phrases/{pid}", json={"answer": "Merci bien.", "translation": "Thanks", "tags": []}).status_code == 200
    assert "Merci bien." in phrases(c, sid)
    assert c.delete(f"/subjects/{sid}/phrases/{pid}").status_code == 204
    assert "Merci bien." not in phrases(c, sid)


def test_replace_path_removes_old_lessons_and_questions(course):
    c, sid = course
    r = c.put(f"/subjects/{sid}/content/path", json={"lessons": [{"title": "Only lesson", "content": "x", "questions": [q("N1")]}]})
    assert r.status_code == 200
    w = c.get(f"/subjects/{sid}/workspace").json()
    assert [n["title"] for n in w["roadmap"]] == ["Only lesson"] and len(w["tests"]) == 1
    assert len(w["cards"]) == 4  # other parts are untouched


def test_unknown_part_is_404(course):
    c, sid = course
    assert c.put(f"/subjects/{sid}/content/nonsense", json={}).status_code == 404


# ------------------------------------------------------------------ questions

def test_bulk_delete_questions(course):
    c, sid = course
    ids = [t["id"] for t in c.get(f"/subjects/{sid}/workspace").json()["tests"]]
    r = c.post(f"/subjects/{sid}/tests/bulk-delete", json={"ids": ids[:3] + ["00000000-0000-0000-0000-000000000000"]})
    assert r.status_code in (200, 204)
    assert len(c.get(f"/subjects/{sid}/tests").json()) == len(ids) - 3
    assert c.post(f"/subjects/{sid}/tests/bulk-delete", json={"ids": ["not-a-uuid"]}).status_code == 422


def test_attempt_flags_and_clears_a_mistake(course):
    c, sid = course
    t = c.get(f"/subjects/{sid}/workspace").json()["tests"][0]
    wrong, right = 1 - t["correct_index"], t["correct_index"]
    assert c.post(f"/subjects/{sid}/tests/{t['id']}/attempts", json={"selected_index": wrong}).status_code in (200, 201)
    assert [m["question"]["id"] for m in c.get(f"/subjects/{sid}/mistakes").json()] == [t["id"]]
    c.post(f"/subjects/{sid}/tests/{t['id']}/attempts", json={"selected_index": right})
    assert c.get(f"/subjects/{sid}/mistakes").json() == []


# ------------------------------------------------------------------ one account cannot see another's data

def test_other_accounts_cannot_touch_my_subject(course, bob):
    c, sid = course
    w = c.get(f"/subjects/{sid}/workspace").json()
    nid, rid, tid = w["roadmap"][0]["id"], w["readings"][0]["id"], w["tests"][0]["id"]
    pid, cid = w["phrases"][0]["id"], w["cards"][0]["id"]
    base = f"/subjects/{sid}"
    probes = [
        ("get", base, None), ("get", base + "/workspace", None), ("get", base + "/export", None),
        ("get", base + "/roadmap", None), ("get", f"{base}/nodes/{nid}", None), ("get", f"{base}/readings/{rid}", None),
        ("get", base + "/roadmap/search?q=a", None), ("get", base + "/tests", None), ("get", base + "/vocab", None),
        ("put", f"{base}/nodes/{nid}", {"title": "hacked"}),
        ("put", f"{base}/phrases/{pid}", {"answer": "hacked", "translation": "", "tags": []}),
        ("delete", f"{base}/phrases/{pid}", None),
        ("delete", f"{base}/vocab/{cid}", None),
        ("delete", f"{base}/tests/{tid}", None),
        ("post", base + "/tests/bulk-delete", {"ids": [tid]}),
        ("post", base + "/import", {"vocabulary": [{"term": "x", "definition": "y"}]}),
        ("put", base + "/content/vocabulary", {"vocabulary": []}),
        ("put", base + "/content/path", {"lessons": []}),
    ]
    for method, path, body in probes:
        r = getattr(bob, method)(path, **({"json": body} if body is not None else {}))
        # Bob is signed in, so the answer must be "not found": never data, never success.
        assert r.status_code in (404, 422), (method, path, r.status_code)
    assert bob.request("DELETE", base, json={"confirmation": "French basics"}).status_code == 404
    assert bob.get("/subjects").json() == []
    # nothing of Alice's changed
    after = c.get(base + "/workspace").json()
    for key in ("roadmap", "tests", "cards", "readings", "phrases"):
        assert len(after[key]) == len(w[key]), key
    assert c.get(f"{base}/nodes/{nid}").json()["title"] == "Greetings"


def test_subject_lists_are_private(app):
    a, b = new_client(app), new_client(app)
    import_subject(a)
    assert len(a.get("/subjects").json()) == 1
    assert b.get("/subjects").json() == []


# ------------------------------------------------------------------ subject lifecycle

def test_delete_subject_needs_exact_title(course):
    c, sid = course
    assert c.request("DELETE", f"/subjects/{sid}", json={"confirmation": "wrong"}).status_code == 422
    assert c.request("DELETE", f"/subjects/{sid}", json={"confirmation": "French basics"}).status_code == 204
    assert c.get(f"/subjects/{sid}").status_code == 404


def test_edit_subject(course):
    c, sid = course
    r = c.put(f"/subjects/{sid}", json={"title": "Renamed subject", "description": "new description"})
    assert r.status_code == 200 and c.get(f"/subjects/{sid}").json()["title"] == "Renamed subject"
