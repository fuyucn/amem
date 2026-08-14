"""OmniMemEval client adaptor for Amem (self-hosted agent memory).

This module maps the OmniMemEval harness interface onto the Amem REST API.
Install it into a harness checkout (``scripts/client_factory/amem_client.py``)
and register it in ``registry.py`` + ``locomo_search.py`` — see ``install.sh``.

Isolation model
---------------
Amem scopes every unit inside a **workspace**.  OmniMemEval's LoCoMo runner
uses one ``user_id`` per speaker per conversation; both speakers of a
conversation share the same transcript.  We map both speaker user ids to a
single workspace per conversation (the ``_speaker_a_`` / ``_speaker_b_`` part
is stripped), so the 10 benchmark conversations never bleed into each other —
the exact failure mode that produced 22% cross-user contamination in the
first Amem run.

Auth
----
Requires an admin PAT (``AMEM_API_TOKEN``) when the bench instance runs with
auth enabled (recommended).  The client lazily creates missing workspaces and
scopes every write/read with the ``x-amem-workspace`` header.
"""

from __future__ import annotations

import re
import threading
import time

import requests

from .base_client import BaseApiClient, env_int, env_str


_SPEAKER_RE = re.compile(r"_speaker_[ab]_", re.IGNORECASE)


class AmemClient(BaseApiClient):
    """Amem REST client for the OmniMemEval harness."""

    _API_PREFIX = "/api/v1"

    def __init__(self):
        base_url = env_str("AMEM_BASE_URL", "http://127.0.0.1:8321")
        token = env_str("AMEM_API_TOKEN")
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        timeout = env_int("AMEM_TIMEOUT", 1500, min_value=1)
        super().__init__(base_url, headers, timeout=timeout)
        self._token = token
        self._ensured: set[str] = set()
        # (workspace_slug, session_key) -> True.  The harness adds the same
        # session twice (once per speaker); both map to the same workspace with
        # an identical transcript, so the second call is a pure duplicate.
        self._ingested: set[tuple[str, str]] = set()
        self._ingest_lock = threading.Lock()

    # ── workspace mapping ────────────────────────────────────────────────

    @staticmethod
    def _workspace_slug(user_id: str) -> str:
        """Map a harness user id to a stable workspace slug.

        Both speakers of one LoCoMo conversation map to the same workspace:
        ``locomo_exp_user_3_speaker_a_v1`` -> ``locomo-exp-user-3-v1``.
        Unknown formats fall back to a slugified user id.
        """
        slug = _SPEAKER_RE.sub("_", user_id or "")
        slug = re.sub(r"[^a-z0-9-]+", "-", slug.lower()).strip("-")
        return slug or "bench-workspace"

    def _ws_headers(self, user_id: str) -> dict:
        headers = dict(self.headers)
        headers["x-amem-workspace"] = self._workspace_slug(user_id)
        return headers

    def _ensure_workspace(self, user_id: str) -> None:
        slug = self._workspace_slug(user_id)
        if slug in self._ensured:
            return

        def _exists() -> bool:
            resp = self._get(
                f"{self._API_PREFIX}/workspaces",
                headers=self.headers,
            )
            if resp.status_code not in (200,):
                return False
            for ws in resp.json() or []:
                if ws.get("slug") == slug:
                    return True
            return False

        if not _exists():
            resp = self._retry(
                lambda: self._post(
                    f"{self._API_PREFIX}/workspaces",
                    json={"slug": slug, "name": f"OmniMemEval {slug}"},
                    headers=self.headers,
                )
            )
            if resp.status_code not in (200, 201, 409):
                # Concurrent creation may still race to a 500 on some builds;
                # re-check existence before giving up.
                if not _exists():
                    body = (resp.text or "")[:500]
                    raise requests.exceptions.HTTPError(
                        f"amem workspace create failed: {resp.status_code} {resp.reason}; body={body}",
                        response=resp,
                    )
        self._ensured.add(slug)

    # ── harness interface ────────────────────────────────────────────────

    def add(self, messages, user_id, **kwargs):
        """Ingest one session: distill the speaker-labelled transcript into
        atomic memory units in the conversation's workspace."""
        slug = self._workspace_slug(user_id)
        session_key = kwargs.get("session_key") or kwargs.get("conv_id")
        if session_key:
            key = (slug, str(session_key))
            with self._ingest_lock:
                if key in self._ingested:
                    return

        self._ensure_workspace(user_id)

        lines = []
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            content = msg.get("content") or ""
            speaker = msg.get("name")
            chat_time = msg.get("chat_time")
            prefix = f"[{chat_time}] " if chat_time else ""
            lines.append(f"{prefix}{speaker or msg.get('role', '')}: {content}".strip())
        content = "\n".join(lines).strip()
        if not content:
            return

        title = (
            f"LoCoMo {slug}"
            + (f" {session_key}" if session_key else "")
        )
        payload = {
            "title": title,
            "content": content,
            "extract": True,
            "autoLink": True,
        }
        if session_key:
            payload["sessionId"] = f"{user_id}:{session_key}"

        def _do():
            resp = self._post(
                f"{self._API_PREFIX}/ingest",
                json=payload,
                headers=self._ws_headers(user_id),
            )
            if resp.status_code not in (200, 201, 202):
                body = (resp.text or "")[:1000]
                raise requests.exceptions.HTTPError(
                    f"amem ingest failed: {resp.status_code} {resp.reason}; body={body}",
                    response=resp,
                )
            return resp.json()

        self._retry(_do)
        if session_key:
            with self._ingest_lock:
                self._ingested.add((slug, str(session_key)))

    def search(self, query, user_id, top_k):
        """Recall a compact, cited context block for *query* from the
        conversation's workspace."""
        self._ensure_workspace(user_id)

        payload = {
            "query": query,
            "tokenBudget": 12000,
            "topK": top_k,
            "includeBody": True,
        }

        def _do():
            resp = self._post(
                f"{self._API_PREFIX}/recall",
                json=payload,
                headers=self._ws_headers(user_id),
            )
            resp.raise_for_status()
            return resp.json()

        result = self._retry(_do)
        text = result.get("text") if isinstance(result, dict) else None
        return text or ""

    def delete_user(self, user_id):
        """Delete every unit in the conversation's workspace (idempotent)."""
        slug = self._workspace_slug(user_id)
        headers = self._ws_headers(user_id)
        while True:
            units = self._retry(
                lambda: self._get(
                    f"{self._API_PREFIX}/units",
                    params={"limit": 500},
                    headers=headers,
                ).json()
            )
            items = units.get("units", units.get("items", units)) if isinstance(units, dict) else units
            items = items or []
            if not items:
                return
            for unit in items:
                unit_id = unit.get("id") if isinstance(unit, dict) else None
                if not unit_id:
                    continue
                resp = self._retry(
                    lambda uid=unit_id: self._delete(
                        f"{self._API_PREFIX}/units/{uid}", headers=headers
                    )
                )
                if resp.status_code not in (200, 202, 204, 404):
                    resp.raise_for_status()
            if len(items) < 500:
                return
            time.sleep(0.2)
