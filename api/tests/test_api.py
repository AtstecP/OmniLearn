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
        ("get", base + "/canvas", None),
        ("put", base + "/canvas/layout", {"base_version": 0, "update_nodes": [{"id": nid, "position_x": 5}]}),
        ("post", base + "/edges", {"source_node_id": nid, "target_node_id": nid}),
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


# ------------------------------------------------------------------ canvas

def canvas(c, sid):
    r = c.get(f"/subjects/{sid}/canvas")
    assert r.status_code == 200, r.text
    return r.json()


def save(c, sid, body):
    return c.put(f"/subjects/{sid}/canvas/layout", json=body)


def test_import_places_lessons_and_links_nesting(course):
    c, sid = course
    cv = canvas(c, sid)
    lessons = {n["title"]: n for n in cv["nodes"]}
    assert set(lessons) == {"Greetings", "Formal", "Informal", "Food"}
    assert all(n["node_type"] == "material" for n in lessons.values())
    # sub-topics sit to the right of their parent, every nesting link is an edge
    assert lessons["Formal"]["position_x"] > lessons["Greetings"]["position_x"]
    pairs = {(e["source_node_id"], e["target_node_id"]) for e in cv["edges"]}
    assert (lessons["Greetings"]["id"], lessons["Formal"]["id"]) in pairs
    assert (lessons["Greetings"]["id"], lessons["Informal"]["id"]) in pairs
    assert len(pairs) == 2
    assert "content_markdown" not in lessons["Greetings"]
    w = c.get(f"/subjects/{sid}/workspace").json()
    assert w["canvas"]["version"] == cv["version"] and len(w["canvas"]["edges"]) == 2 and w["canvas"]["nodes"] == []
    assert w["canvas"]["subject_id"] == sid and cv["subject_id"] == sid  # the client only trusts data tagged with its own subject


def test_canvas_batch_create_move_connect_and_delete(course):
    c, sid = course
    cv = canvas(c, sid)
    g = next(n for n in cv["nodes"] if n["title"] == "Greetings")
    r = save(c, sid, {"base_version": cv["version"],
                      "create_nodes": [{"client_id": "n1", "node_type": "note", "title": "", "position_x": 10, "position_y": 20, "metadata": {"text": "hi", "color": "yellow"}},
                                       {"client_id": "t1", "node_type": "topic", "title": "Verbs", "position_x": -300, "position_y": 0}],
                      "update_nodes": [{"id": g["id"], "position_x": 777, "position_y": -55}],
                      "create_edges": [{"client_id": "e1", "source": "n1", "target": g["id"], "edge_type": "explains", "label": "see"},
                                       {"source": "t1", "target": "n1"}]})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["version"] == cv["version"] + 1 and set(out["id_map"]) == {"n1", "t1", "e1"} and out["lessons_changed"] is False
    cv2 = canvas(c, sid)
    byid = {n["id"]: n for n in cv2["nodes"]}
    note = byid[out["id_map"]["n1"]]
    assert note["node_type"] == "note" and note["title"] == "Note" and note["metadata"] == {"text": "hi", "color": "yellow"}
    assert byid[g["id"]]["position_x"] == 777 and byid[g["id"]]["position_y"] == -55
    e1 = next(e for e in cv2["edges"] if e["id"] == out["id_map"]["e1"])
    assert e1["edge_type"] == "explains" and e1["label"] == "see"
    # the lesson list (and its text) is untouched by canvas-only blocks
    w = c.get(f"/subjects/{sid}/workspace").json()
    assert len(w["roadmap"]) == 4 and {n["node_type"] for n in w["roadmap"]} == {"material"}
    assert c.get(f"/subjects/{sid}/nodes/{g['id']}").json()["content_markdown"].startswith("# Greetings")
    # update an edge, delete the note: its edges go with it
    r = save(c, sid, {"base_version": out["version"], "update_edges": [{"id": e1["id"], "edge_type": "related_to", "label": ""}],
                      "delete_nodes": [note["id"]]})
    assert r.status_code == 200, r.text
    cv3 = canvas(c, sid)
    assert note["id"] not in {n["id"] for n in cv3["nodes"]}
    assert all(note["id"] not in (e["source_node_id"], e["target_node_id"]) for e in cv3["edges"])


def test_canvas_stale_version_is_rejected(course):
    c, sid = course
    cv = canvas(c, sid)
    g = cv["nodes"][0]
    assert save(c, sid, {"base_version": cv["version"], "update_nodes": [{"id": g["id"], "position_x": 1}]}).status_code == 200
    r = save(c, sid, {"base_version": cv["version"], "update_nodes": [{"id": g["id"], "position_x": 2}]})
    assert r.status_code == 409 and r.json()["detail"]["version"] == cv["version"] + 1
    assert next(n for n in canvas(c, sid)["nodes"] if n["id"] == g["id"])["position_x"] == 1


def test_canvas_rejects_bad_edges_and_saves_nothing(course):
    c, sid = course
    cv = canvas(c, sid)
    g = cv["nodes"][0]["id"]
    for edge in ({"source": g, "target": g}, {"source": g, "target": "nope"}, {"source": g, "target": "00000000-0000-0000-0000-000000000000"},
                 {"source": g, "target": cv["nodes"][1]["id"], "edge_type": "bogus"}):
        r = save(c, sid, {"base_version": cv["version"], "create_nodes": [{"client_id": "x", "node_type": "note", "title": "keep?"}], "create_edges": [edge]})
        assert r.status_code == 422, (edge, r.status_code)
    after = canvas(c, sid)
    assert after["version"] == cv["version"] and len(after["nodes"]) == len(cv["nodes"])


def test_canvas_lesson_blocks_are_lessons(course):
    c, sid = course
    cv = canvas(c, sid)
    g = next(n for n in cv["nodes"] if n["title"] == "Greetings")
    r = save(c, sid, {"base_version": cv["version"], "create_nodes": [{"client_id": "m", "node_type": "material", "title": "Copy", "copy_of": g["id"]}]})
    assert r.status_code == 200 and r.json()["lessons_changed"] is True
    new_id = r.json()["id_map"]["m"]
    lesson = c.get(f"/subjects/{sid}/nodes/{new_id}").json()
    assert lesson["content_markdown"].startswith("# Greetings") and lesson["test_ids"] == []
    w = c.get(f"/subjects/{sid}/workspace").json()
    assert new_id in {n["id"] for n in w["roadmap"]}
    # deleting the original lesson block deletes the lesson; its sub-topics move up, its questions stay in the bank
    tests_before = len(w["tests"])
    r = save(c, sid, {"base_version": r.json()["version"], "delete_nodes": [g["id"]]})
    assert r.status_code == 200
    w2 = c.get(f"/subjects/{sid}/workspace").json()
    assert g["id"] not in {n["id"] for n in w2["roadmap"]} and len(w2["tests"]) == tests_before
    formal = next(n for n in w2["roadmap"] if n["title"] == "Formal")
    assert formal["parent_node_id"] is None


def test_progress_and_tests_survive_canvas_moves(course):
    c, sid = course
    cv = canvas(c, sid)
    g = next(n for n in cv["nodes"] if n["title"] == "Greetings")
    assert c.post(f"/subjects/{sid}/nodes/{g['id']}/progress?status=mastered").status_code == 200
    save(c, sid, {"base_version": cv["version"], "update_nodes": [{"id": g["id"], "position_x": 5000, "position_y": 5000}]})
    w = c.get(f"/subjects/{sid}/workspace").json()
    assert w["progress"][g["id"]] == "mastered"
    assert len(next(n for n in w["roadmap"] if n["id"] == g["id"])["test_ids"]) == 2


def test_replace_path_keeps_canvas_only_blocks(course):
    c, sid = course
    cv = canvas(c, sid)
    r = save(c, sid, {"base_version": cv["version"], "create_nodes": [{"client_id": "n", "node_type": "note", "title": "Mine", "position_x": -999}]})
    note_id = r.json()["id_map"]["n"]
    assert c.put(f"/subjects/{sid}/content/path", json={"lessons": [{"title": "Only", "content": "x"}]}).status_code == 200
    after = canvas(c, sid)
    titles = {n["title"] for n in after["nodes"]}
    assert titles == {"Only", "Mine"} and after["version"] > r.json()["version"]
    only = next(n for n in after["nodes"] if n["title"] == "Only")
    assert only["position_y"] > -999 and note_id in {n["id"] for n in after["nodes"]}


def test_single_edge_routes(course):
    c, sid = course
    cv = canvas(c, sid)
    a, b = cv["nodes"][0]["id"], cv["nodes"][-1]["id"]
    r = c.post(f"/subjects/{sid}/edges", json={"source_node_id": a, "target_node_id": b, "edge_type": "tests", "label": "quiz"})
    assert r.status_code == 201, r.text
    eid = r.json()["id"]
    assert c.post(f"/subjects/{sid}/edges", json={"source_node_id": a, "target_node_id": a}).status_code == 422
    r = c.put(f"/subjects/{sid}/edges/{eid}", json={"edge_type": "references", "label": None})
    assert r.json()["edge_type"] == "references" and r.json()["label"] is None
    assert c.delete(f"/subjects/{sid}/edges/{eid}").status_code == 204
    assert eid not in {e["id"] for e in canvas(c, sid)["edges"]}


def test_add_milestone_gets_a_position_and_edge(course):
    c, sid = course
    cv = canvas(c, sid)
    g = next(n for n in cv["nodes"] if n["title"] == "Greetings")
    r = c.post(f"/subjects/{sid}/nodes", json={"title": "Child", "parent_node_id": g["id"]})
    assert r.status_code == 201
    child = r.json()
    assert child["position_x"] == g["position_x"] + 340 and child["node_type"] == "material"
    assert any(e["source_node_id"] == g["id"] and e["target_node_id"] == child["id"] for e in canvas(c, sid)["edges"])
