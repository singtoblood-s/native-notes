#!/usr/bin/env python3
"""Stdlib-only smoke test for large NotePad snapshots.

The test creates two disposable QA accounts, keeps credentials and note data
in memory, and only prints case names plus payload sizes. Run it against the
explicit API deployment with ``--url``.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import secrets
import sys
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)
STAMP = "2026-01-01T00:00:00Z"
LARGE_PAGE_MIN_BYTES = 1_900_000


class SmokeFailure(Exception):
    def __init__(self, case: str, message: str) -> None:
        super().__init__(message)
        self.case = case
        self.message = message


@dataclass
class HttpResult:
    status: int
    headers: dict[str, str]
    value: Any


def new_id() -> str:
    return str(uuid.uuid4())


def assert_true(case: str, condition: bool, message: str = "assertion failed") -> None:
    if not condition:
        raise SmokeFailure(case, message)


def object_value(case: str, value: Any) -> dict[str, Any]:
    assert_true(case, isinstance(value, dict), "expected JSON object")
    return value


class LargeNoteSmoke:
    def __init__(self, base_url: str, origin: str, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.origin = origin
        self.timeout = timeout
        self.tokens: list[str] = []

    def request(
        self,
        case: str,
        method: str,
        path: str,
        token: str | None = None,
        body: Any = None,
    ) -> HttpResult:
        headers = {
            "Accept": "application/json",
            "Origin": self.origin,
            "User-Agent": "NativeNotes-Smoke/1.0",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data: bytes | None = None
        if body is not None:
            data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                status = response.status
                response_headers = {key.lower(): value for key, value in response.headers.items()}
        except HTTPError as response:
            raw = response.read()
            status = response.code
            response_headers = {key.lower(): value for key, value in response.headers.items()}
        except (URLError, TimeoutError, OSError) as error:
            raise SmokeFailure(case, "network unavailable") from error
        try:
            value: Any = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            value = None
        return HttpResult(status, response_headers, value)

    def expect_status(self, case: str, response: HttpResult, *statuses: int) -> None:
        assert_true(case, response.status in statuses, f"unexpected HTTP status {response.status}")

    def auth(self, case: str, response: HttpResult) -> dict[str, Any]:
        self.expect_status(case, response, 200)
        payload = object_value(case, response.value)
        user = object_value(case, payload.get("user"))
        assert_true(case, isinstance(user.get("id"), str) and UUID_RE.fullmatch(user["id"]) is not None, "invalid user id")
        assert_true(case, isinstance(payload.get("sessionToken"), str) and bool(payload["sessionToken"]), "invalid session token")
        return payload

    def create_account(self, case: str) -> dict[str, str]:
        identifier = f"notepad-large-qa-{secrets.token_hex(10)}@example.test"
        password = f"Large-QA-{secrets.token_urlsafe(18)}"
        registered = self.auth(case, self.request(case, "POST", "/v1/auth/register", body={"identifier": identifier, "password": password}))
        logged_in = self.auth(case, self.request(case, "POST", "/v1/auth/login", body={"identifier": identifier, "password": password}))
        assert_true(case, registered["user"]["id"].lower() == logged_in["user"]["id"].lower(), "login returned a different account")
        token = logged_in["sessionToken"]
        self.tokens.append(token)
        return {"token": token, "user_id": logged_in["user"]["id"]}

    def push(self, case: str, token: str, operation: dict[str, Any]) -> dict[str, Any]:
        response = self.request(case, "POST", "/v1/sync/push", token=token, body={"operations": [operation]})
        self.expect_status(case, response, 200)
        payload = object_value(case, response.value)
        results = payload.get("results")
        assert_true(case, isinstance(results, list) and len(results) == 1, "invalid push result count")
        assert_true(case, isinstance(payload.get("cursor"), int) and payload["cursor"] >= 0, "invalid push cursor")
        result = object_value(case, results[0])
        assert_true(case, result.get("opId") == operation["opId"], "push result id mismatch")
        return payload

    def pull(self, case: str, token: str, cursor: int, limit: int = 100) -> dict[str, Any]:
        response = self.request(case, "GET", f"/v1/sync/pull?cursor={cursor}&limit={limit}", token=token)
        self.expect_status(case, response, 200)
        payload = object_value(case, response.value)
        changes = payload.get("changes")
        assert_true(case, isinstance(changes, list), "invalid pull changes")
        assert_true(case, isinstance(payload.get("nextCursor"), int) and payload["nextCursor"] >= cursor, "invalid pull cursor")
        assert_true(case, isinstance(payload.get("hasMore"), bool), "invalid pull continuation")
        return payload

    def operation(
        self,
        entity_type: str,
        entity_id: str,
        payload: dict[str, Any],
        base_revision: int = 0,
        action: str = "upsert",
    ) -> dict[str, Any]:
        return {
            "opId": new_id(),
            "entityType": entity_type,
            "entityId": entity_id,
            "baseRevision": base_revision,
            "action": action,
            "payload": payload,
            "createdAt": STAMP,
        }

    def notebook(self, notebook_id: str) -> dict[str, Any]:
        return {
            "id": notebook_id,
            "title": "Large note QA notebook",
            "createdAt": STAMP,
            "updatedAt": STAMP,
            "deletedAt": None,
            "revision": 0,
        }

    def large_page(self, page_id: str, notebook_id: str) -> dict[str, Any]:
        strokes: list[dict[str, Any]] = []
        points_per_stroke = 100
        for stroke_index in range(350):
            points = [
                {
                    "x": (stroke_index * 17 + point_index) % 1000,
                    "y": (stroke_index * 29 + point_index * 3) % 1000,
                    "pressure": 0.25 + (point_index % 50) / 100,
                    "time": stroke_index * points_per_stroke + point_index,
                    "tiltX": (point_index % 61) - 30,
                    "tiltY": 30 - (point_index % 61),
                }
                for point_index in range(points_per_stroke)
            ]
            strokes.append({"id": new_id(), "color": 0xFF1B1B1F, "width": 2.5, "points": points})
        return {
            "id": page_id,
            "notebookId": notebook_id,
            "title": "Large QA page",
            "text": "large page QA text " * 10_000,
            "background": "grid",
            "width": 1024,
            "height": 1366,
            "strokes": strokes,
            "formatVersion": 1,
            "revision": 0,
            "updatedAt": STAMP,
            "deletedAt": None,
        }

    def assert_page_content(self, case: str, expected: dict[str, Any], actual: Any) -> None:
        payload = object_value(case, actual)
        for key in ("id", "notebookId", "title", "text", "background", "width", "height", "formatVersion"):
            assert_true(case, payload.get(key) == expected[key], f"page field {key} changed")
        assert_true(case, payload.get("strokes") == expected["strokes"], "ink points changed")

    def change_for(self, case: str, changes: Any, entity_id: str) -> dict[str, Any]:
        matches = [change for change in changes if isinstance(change, dict) and change.get("entityId") == entity_id]
        assert_true(case, len(matches) == 1, "pull omitted or duplicated the entity change")
        return matches[0]

    def run(self) -> None:
        accounts: list[dict[str, str]] = []
        try:
            self.health()
            accounts = [self.create_account("qa-account"), self.create_account("qa-account")]
            first, second = accounts
            notebook_id = new_id()
            page_id = new_id()
            notebook = self.notebook(notebook_id)
            notebook_operation = self.operation("notebook", notebook_id, notebook)
            notebook_push = self.push("notebook-push", first["token"], notebook_operation)
            notebook_result = object_value("notebook-push", notebook_push["results"][0])
            assert_true("notebook-push", notebook_result.get("status") == "acked" and notebook_result.get("revision") == 1, "notebook was not acknowledged")

            large = self.large_page(page_id, notebook_id)
            page_bytes = len(json.dumps(large, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
            assert_true("large-page-size", page_bytes > LARGE_PAGE_MIN_BYTES, "large page did not exceed 1.9 MiB")
            page_operation = self.operation("page", page_id, large)
            page_push = self.push("large-page-push", first["token"], page_operation)
            page_result = object_value("large-page-push", page_push["results"][0])
            assert_true("large-page-push", page_result.get("status") == "acked" and page_result.get("revision") == 1, "large page was not acknowledged")

            pulled = self.pull("large-page-pull", first["token"], 0)
            page_change = self.change_for("large-page-pull", pulled["changes"], page_id)
            assert_true("large-page-pull", page_change.get("action") == "upsert", "large page pull was not an upsert")
            self.assert_page_content("large-page-pull", large, page_change.get("payload"))
            cursor = pulled["nextCursor"]
            print(f"PASS large-page-push-pull bytes={page_bytes}")

            retry = self.push("idempotent-retry", first["token"], copy.deepcopy(page_operation))
            retry_result = object_value("idempotent-retry", retry["results"][0])
            assert_true("idempotent-retry", retry_result == page_result, "retry changed the acknowledged revision")
            print("PASS idempotent-retry")

            stale = copy.deepcopy(large)
            stale["text"] = "stale QA edit"
            stale_operation = self.operation("page", page_id, stale, base_revision=0)
            conflict = self.push("stale-conflict", first["token"], stale_operation)
            conflict_result = object_value("stale-conflict", conflict["results"][0])
            assert_true("stale-conflict", conflict_result.get("status") == "conflict" and conflict_result.get("revision") == 1, "stale edit was not rejected")
            self.assert_page_content("stale-conflict", large, conflict_result.get("serverPayload"))
            conflict_retry = self.push("stale-conflict-retry", first["token"], copy.deepcopy(stale_operation))
            assert_true("stale-conflict-retry", object_value("stale-conflict-retry", conflict_retry["results"][0]) == conflict_result, "conflict retry changed the hydrated snapshot")
            print(f"PASS stale-conflict-hydrates bytes={page_bytes}")

            delete_operation = self.operation("page", page_id, copy.deepcopy(large), base_revision=1, action="delete")
            deleted = self.push("delete-large-page", first["token"], delete_operation)
            deleted_result = object_value("delete-large-page", deleted["results"][0])
            assert_true("delete-large-page", deleted_result.get("status") == "acked" and deleted_result.get("revision") == 2, "delete was not acknowledged")
            deleted_pull = self.pull("delete-readable-snapshot", first["token"], cursor)
            delete_change = self.change_for("delete-readable-snapshot", deleted_pull["changes"], page_id)
            assert_true("delete-readable-snapshot", delete_change.get("action") == "delete", "pull omitted the tombstone")
            self.assert_page_content("delete-readable-snapshot", large, delete_change.get("payload"))
            delete_payload = object_value("delete-readable-snapshot", delete_change.get("payload"))
            assert_true("delete-readable-snapshot", isinstance(delete_payload.get("deletedAt"), str), "tombstone has no deletion time")
            print(f"PASS delete-readable-snapshot bytes={page_bytes}")

            other_before = self.pull("account-isolation-empty", second["token"], 0)
            assert_true("account-isolation-empty", other_before["changes"] == [] and other_before["nextCursor"] == 0, "account saw another account's notes")
            other_notebook_id = new_id()
            other_notebook = self.notebook(other_notebook_id)
            self.push("account-two-write", second["token"], self.operation("notebook", other_notebook_id, other_notebook))
            other_after = self.pull("account-two-read", second["token"], 0)
            assert_true("account-two-read", any(change.get("entityId") == other_notebook_id for change in other_after["changes"] if isinstance(change, dict)), "account could not read its own note")
            assert_true("account-two-read", all(change.get("entityId") not in {notebook_id, page_id} for change in other_after["changes"] if isinstance(change, dict)), "account read another account's note")
            first_after = self.pull("account-one-isolation", first["token"], deleted_pull["nextCursor"])
            assert_true("account-one-isolation", first_after["changes"] == [] and first_after["nextCursor"] == deleted_pull["nextCursor"], "account one read account two's note")
            print("PASS two-account-isolation")
            print("PASS smoke-large-notes")
        finally:
            for token in self.tokens:
                try:
                    self.request("logout", "POST", "/v1/auth/logout", token=token)
                except Exception:
                    pass

    def health(self) -> None:
        case = "health"
        response = self.request(case, "GET", "/health")
        self.expect_status(case, response, 200)
        assert_true(case, response.headers.get("access-control-allow-origin") == self.origin, "origin is not allowed")
        print("PASS health")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smoke test large NotePad snapshots against a worker API.")
    parser.add_argument("--url", required=True, help="Target worker API URL")
    parser.add_argument("--origin", default="https://singtoblood-s.github.io", help="Allowed Origin header")
    parser.add_argument("--timeout", type=float, default=30.0, help="Per-request timeout in seconds")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        LargeNoteSmoke(args.url, args.origin, args.timeout).run()
    except SmokeFailure as failure:
        print(f"FAIL {failure.case}: {failure.message}", file=sys.stderr)
        return 1
    except Exception:
        print("FAIL harness: unexpected error", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
