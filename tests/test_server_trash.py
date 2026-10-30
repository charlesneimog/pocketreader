from email.message import Message
from contextlib import closing
import io
import json
import sqlite3
import tempfile
import unittest
from urllib.parse import quote

import app
from server import APIHandler


ALICE = "alice@example.com"
BOB = "bob@example.com"


class Request(APIHandler):
    """Exercise the real HTTP handlers without opening a socket."""

    def __init__(self, method, path, *, owner=ALICE):
        self.command, self.path = method, path
        self.client_address = ("127.0.0.1", 12345)
        self.headers = Message()
        self.headers["Origin"] = "https://reader.example"
        self.headers["Content-Length"] = "0"
        self.rfile, self.wfile = io.BytesIO(), io.BytesIO()
        self.owner = owner
        self.status, self.response_headers = None, []
        self.ALLOWED_ORIGINS = ["https://reader.example"]
        self.ALLOW_ANY_ORIGIN = False

    def _get_auth_email(self):
        return self.owner

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.response_headers.append((name, value))

    def end_headers(self):
        pass

    def run(self):
        getattr(self, "do_" + self.command)()
        return self

    def json(self):
        return json.loads(self.wfile.getvalue())


class ServerTrashTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.original_db_path = app.DB_PATH
        app.DB_PATH = f"{self.directory.name}/database.db"
        app.init_db()

    def tearDown(self):
        app.DB_PATH = self.original_db_path
        self.directory.cleanup()

    def add_file(self, owner, actual="book.epub", *, title="Book", payload=b"book-data"):
        file_id = f"file::{actual}::{len(payload)}::123"
        app.add_file_with_id(file_id, title, payload, "epub", owner_email=owner)
        return file_id

    def test_soft_delete_hides_file_and_restore_preserves_payload_and_highlights(self):
        file_id = self.add_file(ALICE)
        bob_file_id = self.add_file(BOB, title="Bob's Book")
        self.assertEqual(
            app.update_highlights(
                file_id,
                [{"sentenceIndex": 3, "color": "#abc", "text": "Remember this"}],
                owner_email=ALICE,
            ),
            1,
        )

        self.assertTrue(app.mark_file_deleted(file_id, owner_email=ALICE))

        self.assertEqual(app.get_files(owner_email=ALICE), [])
        self.assertIsNone(app.get_file_blob(file_id, owner_email=ALICE))
        self.assertEqual(app.get_highlights(file_id, owner_email=ALICE), [])
        self.assertEqual(len(app.get_files(owner_email=BOB)), 1)
        self.assertEqual(app.get_file_blob(bob_file_id, owner_email=BOB), b"book-data")

        trash = app.get_trashed_files(owner_email=ALICE)
        self.assertEqual(len(trash), 1)
        self.assertEqual(trash[0]["file_id"], "book.epub")
        self.assertEqual(trash[0]["title"], "Book")
        self.assertEqual(trash[0]["size"], len(b"book-data"))

        self.assertTrue(app.restore_file_from_trash("book.epub", owner_email=ALICE))
        self.assertFalse(app.is_file_deleted(file_id, owner_email=ALICE))
        self.assertEqual(app.get_file_blob(file_id, owner_email=ALICE), b"book-data")
        self.assertEqual(app.get_highlights(file_id, owner_email=ALICE)[0]["text"], "Remember this")

    def test_restore_clears_a_tombstone_even_without_a_server_payload(self):
        self.assertTrue(app.mark_file_deleted("local-only.pdf", owner_email=ALICE))
        self.assertTrue(app.is_file_deleted("local-only.pdf", owner_email=ALICE))
        self.assertEqual(app.get_trashed_files(owner_email=ALICE), [])

        self.assertTrue(app.restore_file_from_trash("local-only.pdf", owner_email=ALICE))
        self.assertFalse(app.is_file_deleted("local-only.pdf", owner_email=ALICE))

    def test_permanent_delete_removes_payload_and_highlights_but_keeps_tombstone(self):
        file_id = self.add_file(ALICE, actual="discard.epub")
        app.update_highlights(file_id, [{"sentenceIndex": 1}], owner_email=ALICE)
        app.mark_file_deleted(file_id, owner_email=ALICE)

        self.assertTrue(app.purge_trashed_file("discard.epub", owner_email=ALICE))
        self.assertEqual(app.get_trashed_files(owner_email=ALICE), [])
        self.assertTrue(app.is_file_deleted(file_id, owner_email=ALICE))
        with closing(sqlite3.connect(app.DB_PATH)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM files").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM highlights").fetchone()[0], 0)

    def test_empty_trash_is_owner_scoped(self):
        for actual in ("one.epub", "two.epub"):
            file_id = self.add_file(ALICE, actual=actual)
            app.mark_file_deleted(file_id, owner_email=ALICE)
        bob_file_id = self.add_file(BOB, actual="bob.epub")
        app.mark_file_deleted(bob_file_id, owner_email=BOB)

        self.assertEqual(app.empty_trash(owner_email=ALICE), 2)
        self.assertEqual(app.get_trashed_files(owner_email=ALICE), [])
        self.assertEqual(len(app.get_trashed_files(owner_email=BOB)), 1)
        self.assertTrue(app.is_file_deleted("one.epub", owner_email=ALICE))

    def test_one_owner_cannot_restore_or_purge_another_owners_trash(self):
        bob_file_id = self.add_file(BOB, actual="private.epub")
        app.mark_file_deleted(bob_file_id, owner_email=BOB)

        self.assertFalse(app.restore_file_from_trash("private.epub", owner_email=ALICE))
        self.assertFalse(app.purge_trashed_file("private.epub", owner_email=ALICE))
        self.assertEqual(len(app.get_trashed_files(owner_email=BOB)), 1)
        self.assertTrue(app.is_file_deleted(bob_file_id, owner_email=BOB))

    def test_trash_http_routes(self):
        file_id = self.add_file(ALICE, actual="route book.epub")
        encoded = quote("route book.epub", safe="")

        delete_request = Request("DELETE", f"/api/files/{quote(file_id, safe='')}").run()
        self.assertEqual(delete_request.status, 200)

        list_request = Request("GET", "/api/trash").run()
        self.assertEqual(list_request.status, 200)
        self.assertEqual(list_request.json()["files"][0]["filename"], "route book.epub")

        restore_request = Request("POST", f"/api/trash/{encoded}/restore").run()
        self.assertEqual(restore_request.status, 200)
        self.assertTrue(restore_request.json()["restored"])

        Request("DELETE", f"/api/files/{quote(file_id, safe='')}").run()
        purge_request = Request("DELETE", f"/api/trash/{encoded}").run()
        self.assertEqual(purge_request.status, 200)
        self.assertEqual(Request("GET", "/api/trash").run().json()["files"], [])

    def test_trash_routes_require_authentication(self):
        for method, path in (
            ("GET", "/api/trash"),
            ("POST", "/api/trash/book.epub/restore"),
            ("DELETE", "/api/trash"),
            ("DELETE", "/api/trash/book.epub"),
        ):
            request = Request(method, path, owner=None).run()
            self.assertEqual(request.status, 401)


if __name__ == "__main__":
    unittest.main()
