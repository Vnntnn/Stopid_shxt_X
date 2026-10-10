"""Serve the decision model over TypeSafe Jev's `/v1/systemone` wire protocol (stdlib only).

Request :  POST /v1/systemone   {"state": <str|dict|list>, "questions": {qid: {...}}, "model": optional}
Response:  {"model", "answers": {qid: {...}}, "usage": {"input_tokens", "output_tokens"}}
           -- the same shape Laya returns as a drop-in for Jev clients (e.g. hs-jev).
Health  :  GET /health

Env: JEV_MODEL (default On-Fly-Jev.pt), JEV_DEVICE (cpu), JEV_HOST (127.0.0.1),
     JEV_PORT (8000), JEV_API_KEY (when set, clients must send `Authorization: Bearer <key>`),
     JEV_MAX_LEN / JEV_HEAD_MAX_LEN (context and question+options token budgets; default 1024 / 256).
Binds to localhost by default; set JEV_HOST=0.0.0.0 yourself to expose it on the network.
"""
import hmac
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from agent import DecisionAgent

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_BODY = 2 * 1024 * 1024
MAX_QUESTIONS = 64


def make_handler(agent, lock, api_key):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, obj):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                return self._send(200, {"status": "ok", "model": agent.name})
            self._send(404, {"detail": "not found"})

        def do_POST(self):
            if self.path != "/v1/systemone":
                return self._send(404, {"detail": "not found"})
            if api_key:
                auth = self.headers.get("authorization", "")
                if not auth.startswith("Bearer ") or not hmac.compare_digest(auth[7:], api_key):
                    return self._send(401, {"detail": "unauthorized"})
            try:
                n = int(self.headers.get("content-length", "0"))
            except ValueError:
                return self._send(400, {"detail": "bad content-length"})
            if n <= 0 or n > MAX_BODY:
                return self._send(413 if n > MAX_BODY else 400, {"detail": "request body missing or too large"})
            try:
                body = json.loads(self.rfile.read(n))
            except ValueError:
                return self._send(400, {"detail": "request body must be valid JSON"})
            if not isinstance(body, dict) or not isinstance(body.get("questions"), dict):
                return self._send(400, {"detail": "request body must be an object with a 'questions' object"})
            if len(body["questions"]) > MAX_QUESTIONS:
                return self._send(422, {"detail": f"at most {MAX_QUESTIONS} questions per request"})
            try:
                with lock:            # one forward pass at a time on the shared model
                    out = agent.predict(body.get("state", ""), body["questions"])
                out["cost_usd"] = 0.0     # self-hosted: lets budget-tracking clients record $0, not a reservation
                return self._send(200, out)
            except ValueError as e:   # question validation: names the question, safe to return
                return self._send(422, {"detail": str(e)})
            except Exception:         # never leak paths / OOM text to clients
                return self._send(500, {"detail": "inference failed"})

        def log_message(self, fmt, *args):
            print("%s - %s" % (self.address_string(), fmt % args))
    return Handler


def main():
    model = os.environ.get("JEV_MODEL", os.path.join(HERE, "On-Fly-Jev.pt"))
    device = os.environ.get("JEV_DEVICE", "cpu")
    host, port = os.environ.get("JEV_HOST", "127.0.0.1"), int(os.environ.get("JEV_PORT", "8000"))
    agent = DecisionAgent(model, HERE, device)
    # Optional context overrides (trained at 1024 / 256; positions go to 2048).
    agent.max_len = int(os.environ.get("JEV_MAX_LEN", agent.max_len))
    agent.head_max_len = int(os.environ.get("JEV_HEAD_MAX_LEN", agent.head_max_len))
    srv = ThreadingHTTPServer((host, port), make_handler(agent, threading.Lock(), os.environ.get("JEV_API_KEY")))
    print(f"Serving {agent.name} on http://{host}:{port}/v1/systemone  (device={device})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
