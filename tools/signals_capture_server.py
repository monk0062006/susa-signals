"""Trivial capture server for the iOS-simulator wire test (SPEC-173 §3 #1).

Records every ingest request body to a JSONL file and answers just enough for
the SDK to consider the delivery successful. Deliberately has NO database and NO
validation — the point is only to capture what the real Swift SDK emits from the
simulator; the bytes are validated against the actual Python port back in the
SUSA repo's test suite.

stdlib only, so a GitHub macOS runner needs nothing installed.
"""
from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OUT = sys.argv[1] if len(sys.argv) > 1 else "ios_capture.jsonl"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8000


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path.endswith("/health"):
            self._send(200, {"ok": True, "encryptionAtRest": False})
        else:
            self._send(404, {})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(length) if length else b""
        try:
            parsed = json.loads(raw) if raw else None
        except Exception:
            parsed = {"_raw_len": len(raw), "_ct": self.headers.get("content-type")}

        entry = {
            "path": self.path,
            "headers": {k.lower(): v for k, v in self.headers.items()
                        if k.lower() in ("x-project-id", "content-type", "idempotency-key", "user-agent")},
            "body": parsed,
        }
        with open(OUT, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        sys.stderr.write(f"[captured] POST {self.path} ({len(raw)} bytes)\n")
        sys.stderr.flush()

        if "/v1/reports" in self.path:
            self._send(201, {"id": "srv", "duplicate": False})
        elif "/v1/replay/chunks" in self.path:
            self._send(202, {"seq": 0, "accepted": True, "duplicate": False})
        elif "/v1/events" in self.path:
            self._send(202, {"received": 1, "inserted": 1})
        elif "/v1/uploads" in self.path:
            self._send(201, {"id": "00000000-0000-4000-8000-000000000001"})
        else:
            self._send(200, {})

    def log_message(self, *args):  # silence default logging
        pass


if __name__ == "__main__":
    open(OUT, "w").close()
    print(f"capture server on 0.0.0.0:{PORT} -> {OUT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
