#!/usr/bin/env python3
"""Small stdlib-only HTTP smoke test for the Cloudflare sync worker.

The test creates two synthetic example accounts and keeps all credentials,
tokens, and note payloads in memory. The accounts remain on the target; run it
against a local worker or an explicitly supplied deployment URL.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import secrets
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)
STAMP = "2026-01-01T00:00:00Z"


class SmokeFailure(Exception):
    def __init__(self, case: str, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.case = case
        self.message = message
        self.code = code


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


def error_code(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    error = value.get("error")
    if isinstance(error, dict) and isinstance(error.get("code"), str):
        code = error["code"]
        return code if re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", code) else "error"
    return None


class WorkerSmoke:
    def __init__(self, base_url: str, origin: str, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.origin = origin
        self.timeout = timeout

    def request(self, case: str, method: str, path: str, token: str | None = None, body: Any = None, extra_headers: dict[str, str] | None = None) -> HttpResult:
        headers = {"Accept": "application/json", "Origin": self.origin, "User-Agent": "NativeNotes-Smoke/1.0"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data: bytes | None = None
        if body is not None:
            data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if extra_headers:
            headers.update(extra_headers)
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
        assert_true(case, isinstance(user.get("identifier"), str), "invalid user identifier")
        assert_true(case, isinstance(payload.get("sessionToken"), str) and bool(payload["sessionToken"]), "invalid session token")
        assert_true(case, isinstance(payload.get("expiresAt"), str) and bool(payload["expiresAt"]), "invalid session expiry")
        return payload

    def push(self, case: str, token: str, operations: list[dict[str, Any]]) -> dict[str, Any]:
        response = self.request(case, "POST", "/v1/sync/push", token=token, body={"operations": operations})
        self.expect_status(case, response, 200)
        payload = object_value(case, response.value)
        results = payload.get("results")
        assert_true(case, isinstance(results, list) and len(results) == len(operations), "invalid push result count")
        assert_true(case, isinstance(payload.get("cursor"), int) and payload["cursor"] >= 0, "invalid push cursor")
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

    def pull_until_complete(self, case: str, token: str, cursor: int, limit: int = 100) -> dict[str, Any]:
        changes: list[Any] = []
        current_cursor = cursor
        for _ in range(100):
            page = self.pull(case, token, current_cursor, limit)
            changes.extend(page["changes"])
            current_cursor = page["nextCursor"]
            if not page["hasMore"]:
                return {"changes": changes, "nextCursor": current_cursor}
        raise SmokeFailure(case, "pull did not finish within 100 pages")

    def operation(self, entity_type: str, entity_id: str, payload: dict[str, Any], base_revision: int = 0, action: str = "upsert") -> dict[str, Any]:
        return {
            "opId": new_id(),
            "entityType": entity_type,
            "entityId": entity_id,
            "baseRevision": base_revision,
            "action": action,
            "payload": payload,
            "createdAt": STAMP,
        }

    def result(self, case: str, response: dict[str, Any], operation: dict[str, Any]) -> dict[str, Any]:
        value = response["results"][0]
        assert_true(case, isinstance(value, dict), "invalid push result")
        assert_true(case, value.get("opId") == operation["opId"], "push result id mismatch")
        return value

    def run(self) -> None:
        self.health()
        account_one, account_two = self.accounts()
        notebook, page, cursor = self.note_sync(account_one)
        self.auth_isolation(account_two, notebook["id"])
        cursor = self.conflict_and_tombstone(account_one, page, cursor)
        self.oversized_batch(account_one, cursor)
        cursor = self.burst(account_one, cursor)
        self.concurrent_cas(account_one)
        self.expired_cursor(account_one, cursor)
        self.logout(account_one["token"])
        print("PASS smoke-worker")

    def health(self) -> None:
        case = "health"
        response = self.request(case, "GET", "/health")
        self.expect_status(case, response, 200)
        assert_true(case, response.headers.get("access-control-allow-origin") == self.origin, "origin is not allowed")
        preflight = self.request(
            "cors",
            "OPTIONS",
            "/v1/auth/login",
            extra_headers={"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type, authorization"},
        )
        self.expect_status("cors", preflight, 200, 204)
        assert_true("cors", preflight.headers.get("access-control-allow-origin") == self.origin, "origin is not allowed")
        print("PASS health")

    def accounts(self) -> tuple[dict[str, str], dict[str, str]]:
        case = "auth-register-login"
        accounts: list[dict[str, str]] = []
        for _ in range(2):
            identifier = f"notepad-smoke-{secrets.token_hex(10)}@example.test"
            password = f"Smoke-{secrets.token_urlsafe(18)}"
            registered = self.auth(case, self.request(case, "POST", "/v1/auth/register", body={"identifier": identifier, "password": password}))
            logged_in = self.auth(case, self.request(case, "POST", "/v1/auth/login", body={"identifier": identifier, "password": password}))
            assert_true(case, registered["user"]["id"].lower() == logged_in["user"]["id"].lower(), "login returned a different account")
            accounts.append({"identifier": identifier, "password": password, "token": logged_in["sessionToken"], "user_id": logged_in["user"]["id"]})
        wrong = self.request("invalid-password", "POST", "/v1/auth/login", body={"identifier": accounts[0]["identifier"], "password": "wrong-password-123"})
        self.expect_status("invalid-password", wrong, 401)
        print("PASS auth")
        return accounts[0], accounts[1]

    def notebook_snapshot(self, notebook_id: str, title: str = "Smoke notebook") -> dict[str, Any]:
        return {"id": notebook_id, "title": title, "createdAt": STAMP, "updatedAt": STAMP, "revision": 0, "deletedAt": None}

    def page_snapshot(self, page_id: str, notebook_id: str, text: str = "Smoke page", deleted_at: str | None = None) -> dict[str, Any]:
        return {
            "id": page_id,
            "notebookId": notebook_id,
            "title": "Page 1",
            "text": text,
            "background": "blank",
            "width": 1024.0,
            "height": 1366.0,
            "strokes": [],
            "formatVersion": 1,
            "revision": 0,
            "updatedAt": STAMP,
            "deletedAt": deleted_at,
        }

    def note_sync(self, account: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any], int]:
        case = "note-page-push-pull"
        notebook = self.notebook_snapshot(new_id())
        notebook_operation = self.operation("notebook", notebook["id"], notebook)
        first = self.push(case, account["token"], [notebook_operation])
        first_result = self.result(case, first, notebook_operation)
        assert_true(case, first_result.get("status") == "acked" and first_result.get("revision") == 1, "notebook was not acknowledged at revision 1")
        retry = self.push("idempotent-retry", account["token"], [copy.deepcopy(notebook_operation)])
        retry_result = self.result("idempotent-retry", retry, notebook_operation)
        assert_true("idempotent-retry", retry_result == first_result, "retry changed the original operation result")

        different = copy.deepcopy(notebook_operation)
        different["payload"]["title"] = "Tampered notebook"
        mismatch = self.request("idempotency-mismatch", "POST", "/v1/sync/push", token=account["token"], body={"operations": [different]})
        if mismatch.status == 200:
            mismatch_payload = object_value("idempotency-mismatch", mismatch.value)
            mismatch_result = self.result("idempotency-mismatch", mismatch_payload, different)
            assert_true("idempotency-mismatch", mismatch_result.get("status") == "rejected" and mismatch_result.get("code") == "idempotency_mismatch", "tampered retry was accepted")
        else:
            assert_true("idempotency-mismatch", mismatch.status in (400, 409), "tampered retry returned an unexpected status")
            assert_true("idempotency-mismatch", error_code(mismatch.value) == "idempotency_mismatch", "tampered retry returned an unexpected error")

        page = self.page_snapshot(new_id(), notebook["id"])
        page_operation = self.operation("page", page["id"], page)
        page_push = self.push(case, account["token"], [page_operation])
        page_result = self.result(case, page_push, page_operation)
        assert_true(case, page_result.get("status") == "acked" and page_result.get("revision") == 1, "page was not acknowledged at revision 1")
        pulled = self.pull(case, account["token"], 0)
        changes = pulled["changes"]
        notebook_changes = [change for change in changes if isinstance(change, dict) and change.get("entityId") == notebook["id"]]
        page_changes = [change for change in changes if isinstance(change, dict) and change.get("entityId") == page["id"]]
        assert_true(case, len(notebook_changes) == 1 and len(page_changes) == 1, "pull duplicated or omitted a note change")
        assert_true(case, page_changes[0].get("payload", {}).get("id") == page["id"], "pull returned the wrong page")
        assert_true(case, pulled["nextCursor"] >= 1, "pull did not advance the cursor")
        print("PASS notes")
        return notebook, page, pulled["nextCursor"]

    def auth_isolation(self, account: dict[str, str], private_notebook_id: str) -> None:
        case = "auth-isolation"
        pulled = self.pull(case, account["token"], 0)
        assert_true(case, all(change.get("entityId") != private_notebook_id for change in pulled["changes"] if isinstance(change, dict)), "account read another account's change")
        print("PASS isolation")

    def conflict_and_tombstone(self, account: dict[str, str], page: dict[str, Any], cursor: int) -> int:
        case = "cas-conflict"
        stale_page = copy.deepcopy(page)
        stale_page["text"] = "Stale offline edit"
        conflict_operation = self.operation("page", page["id"], stale_page, base_revision=0)
        conflict_push = self.push(case, account["token"], [conflict_operation])
        conflict_result = self.result(case, conflict_push, conflict_operation)
        assert_true(case, conflict_result.get("status") == "conflict" and conflict_result.get("code") == "revision_conflict", "stale edit was not rejected as a conflict")
        server_payload = conflict_result.get("serverPayload")
        assert_true(case, isinstance(server_payload, dict) and server_payload.get("text") == page["text"], "conflict omitted the server snapshot")

        delete_operation = self.operation("page", page["id"], copy.deepcopy(page), base_revision=1, action="delete")
        deleted = self.push("tombstone", account["token"], [delete_operation])
        deleted_result = self.result("tombstone", deleted, delete_operation)
        assert_true("tombstone", deleted_result.get("status") == "acked" and deleted_result.get("revision") == 2, "delete did not create revision 2")
        delete_pull = self.pull("tombstone", account["token"], cursor)
        delete_changes = [change for change in delete_pull["changes"] if isinstance(change, dict) and change.get("entityId") == page["id"]]
        assert_true("tombstone", delete_changes and delete_changes[-1].get("action") == "delete", "pull omitted the tombstone")
        assert_true("tombstone", isinstance(delete_changes[-1].get("payload", {}).get("deletedAt"), str), "tombstone has no deletion time")

        restore_operation = self.operation("page", page["id"], copy.deepcopy(page), base_revision=2)
        restored = self.push("restore", account["token"], [restore_operation])
        restored_result = self.result("restore", restored, restore_operation)
        assert_true("restore", restored_result.get("status") == "acked" and restored_result.get("revision") == 3, "restore did not create revision 3")
        restore_pull = self.pull("restore", account["token"], delete_pull["nextCursor"])
        restore_changes = [change for change in restore_pull["changes"] if isinstance(change, dict) and change.get("entityId") == page["id"]]
        assert_true("restore", restore_changes and restore_changes[-1].get("action") == "upsert", "pull omitted the restore")
        assert_true("restore", restore_changes[-1].get("payload", {}).get("deletedAt") is None, "restored page remains deleted")
        print("PASS conflict-tombstone-restore")
        return restore_pull["nextCursor"]

    def oversized_batch(self, account: dict[str, str], cursor: int) -> None:
        case = "push-limit-11"
        operations = []
        for _ in range(11):
            notebook = self.notebook_snapshot(new_id(), "Rejected burst")
            operations.append(self.operation("notebook", notebook["id"], notebook))
        response = self.request(case, "POST", "/v1/sync/push", token=account["token"], body={"operations": operations})
        self.expect_status(case, response, 413)
        unchanged = self.pull_until_complete("push-limit-no-write", account["token"], cursor)
        assert_true("push-limit-no-write", not unchanged["changes"] and unchanged["nextCursor"] == cursor, "rejected batch changed server state")
        print("PASS push-limit-11")

    def burst(self, account: dict[str, str], cursor: int) -> int:
        case = "burst-100"
        operations = []
        for _ in range(100):
            notebook = self.notebook_snapshot(new_id(), "Burst")
            operations.append(self.operation("notebook", notebook["id"], notebook))
        for offset in range(0, len(operations), 10):
            response = self.push(case, account["token"], operations[offset:offset + 10])
            results = response["results"]
            assert_true(case, all(isinstance(result, dict) and result.get("status") == "acked" and result.get("revision") == 1 for result in results), "a ten-operation batch was not fully acknowledged")
        pulled = self.pull_until_complete("burst-pull", account["token"], cursor)
        expected_ids = {operation["entityId"] for operation in operations}
        actual_ids = {change.get("entityId") for change in pulled["changes"] if isinstance(change, dict)}
        assert_true(case, len(pulled["changes"]) == 100 and actual_ids == expected_ids, "drained burst changes were omitted or duplicated")
        print("PASS burst-100")
        return pulled["nextCursor"]

    def concurrent_cas(self, account: dict[str, str]) -> None:
        case = "concurrent-cas"
        notebook_id = new_id()
        first = self.operation("notebook", notebook_id, self.notebook_snapshot(notebook_id, "Concurrent A"))
        second = self.operation("notebook", notebook_id, self.notebook_snapshot(notebook_id, "Concurrent B"))

        def send(operation: dict[str, Any]) -> HttpResult:
            return self.request(case, "POST", "/v1/sync/push", token=account["token"], body={"operations": [operation]})

        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = [future.result() for future in (executor.submit(send, first), executor.submit(send, second))]
        for response in responses:
            self.expect_status(case, response, 200)
        results = [self.result(case, object_value(case, response.value), operation) for response, operation in zip(responses, (first, second))]
        assert_true(case, sorted(result.get("status") for result in results) == ["acked", "conflict"], "concurrent same-base writes did not split ack and conflict")
        print("PASS concurrent-cas")

    def expired_cursor(self, account: dict[str, str], cursor: int) -> None:
        case = "expired-cursor"
        response = self.request(case, "GET", f"/v1/sync/pull?cursor={cursor + 1000000}&limit=100", token=account["token"])
        self.expect_status(case, response, 409)
        assert_true(case, error_code(response.value) == "cursor_expired", "server did not report cursor_expired")
        print("PASS expired-cursor")

    def logout(self, token: str) -> None:
        case = "logout-401"
        logged_out = self.request(case, "POST", "/v1/auth/logout", token=token)
        self.expect_status(case, logged_out, 204, 200)
        after = self.request(case, "GET", "/v1/sync/pull?cursor=0&limit=1", token=token)
        self.expect_status(case, after, 401)
        print("PASS logout-401")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a sync contract smoke test against a NotePad worker.")
    parser.add_argument("--url", required=True, help="Worker base URL, for example http://127.0.0.1:8787")
    parser.add_argument("--origin", required=True, help="Allowed browser Origin to send with each request")
    parser.add_argument("--timeout", type=float, default=15.0, help="Per-request timeout in seconds")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        WorkerSmoke(args.url, args.origin, args.timeout).run()
    except SmokeFailure as failure:
        suffix = f" code={failure.code}" if failure.code else ""
        print(f"FAIL {failure.case}: {failure.message}{suffix}", file=sys.stderr)
        return 1
    except Exception:
        print("FAIL harness: unexpected error", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
