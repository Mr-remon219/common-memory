#!/usr/bin/env python3
# HISTORICAL: repeated-snapshot assertions are superseded by tests/cli/codex-hook.test.ts.
# Do not use this script as acceptance for the session integration.

"""Real Codex protocol smoke against built Common Memory. Python stdlib only.
Default: isolated synthetic data + loopback fake Responses provider, no credentials.
--live: synthetic three-turn A/B/B acceptance using the current Codex auth, twice
(hooks alone and hooks + read-only MCP). Never copies personal memory or config.
Trust bypass is confined to disposable test threads; product config never enables it.
Reports survive cleanup; credentials, thread state and fixtures do not.
"""
import argparse
import hashlib
import http.server
import json
import os
import pathlib
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
import tomllib

REPO = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--live", action="store_true")
parser.add_argument("--output", type=pathlib.Path)
args = parser.parse_args()
NODE = shutil.which("node")
CODEX = shutil.which("codex")
CLI = REPO / "dist/cli/main.js"
if not NODE or not CODEX or not CLI.is_file():
    parser.error("Node 24, Codex and npm run build are required")
ROOT = pathlib.Path(tempfile.mkdtemp(prefix="cm-codex-hooks-"))
REPORT = args.output or pathlib.Path(str(ROOT) + "-report.json")
report = {"codex_version": subprocess.check_output([CODEX, "--version"], text=True).strip(),
          "node_version": subprocess.check_output([NODE, "--version"], text=True).strip(),
          "mode": "live" if args.live else "wire", "cases": [], "test_trust_bypass": True}
PREFIX = "Current Common Memory snapshot."
QUESTION = ('Who am I and what is my current research direction? Also give my preferred '
            'programming language and souvenir badge code. Return only JSON with keys '
            'identity, research, language, badge, source; use null for unknown values.')
wire = []


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        memories = [p.get("text", "") for item in body.get("input", []) if item.get("role") == "developer"
                    for p in item.get("content", []) if p.get("text", "").startswith(PREFIX)]
        wire.append({"path": self.path, "snapshots": memories,
                     "input_bytes": len(json.dumps(body.get("input", [])).encode())})
        n = len(wire)
        item = {"type": "message", "id": "msg" + str(n), "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": "Synthetic provider response.", "annotations": []}]}
        response = {"id": "response" + str(n), "status": "completed", "output": [item],
                    "usage": {"input_tokens": 100, "output_tokens": 10, "total_tokens": 110}}
        if self.path.endswith("/compact"):
            data = json.dumps({"output": [item]}).encode()
            content_type = "application/json"
        else:
            events = [{"type": "response.created", "response": {"id": response["id"]}},
                      {"type": "response.output_item.done", "output_index": 0, "item": item},
                      {"type": "response.completed", "response": response}]
            data = "".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in events).encode()
            content_type = "text/event-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


provider = None
if not args.live:
    provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()


class Codex:
    def __init__(self, home, work):
        env = {k: v for k, v in os.environ.items()
               if k not in ("CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL", "COMMON_MEMORY_HOME")}
        env["CODEX_HOME"] = str(home)
        self.proc = subprocess.Popen([CODEX, "app-server", "--listen", "stdio://"],
                                     cwd=work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, bufsize=1)
        self.queue = queue.Queue()
        self.events = []
        self.errors = []
        self.next_id = 0
        def read_stdout():
            for line in self.proc.stdout:
                self.queue.put(json.loads(line))
            self.queue.put(None)
        threading.Thread(target=read_stdout, daemon=True).start()
        threading.Thread(target=lambda: [self.errors.append(line) for line in self.proc.stderr],
                         daemon=True).start()
        try:
            self.call("initialize", {"clientInfo": {"name": "cm_hook_smoke", "version": "1"},
                                     "capabilities": {"experimentalApi": True}})
            self.send("initialized", {})
        except Exception:
            self.close()
            raise

    def send(self, method, params, ident=None):
        message = {"method": method, "params": params}
        if ident is not None:
            message["id"] = ident
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def receive(self, deadline):
        message = self.queue.get(timeout=max(.01, deadline - time.monotonic()))
        if message is None:
            raise RuntimeError("Codex exited: " + "".join(self.errors)[-3000:])
        if "method" in message:
            self.events.append(message)
        if "method" in message and "id" in message:
            raise RuntimeError("Unexpected server request: " + message["method"])
        return message

    def call(self, method, params):
        self.next_id += 1
        ident = self.next_id
        self.send(method, params, ident)
        deadline = time.monotonic() + 45
        while True:
            message = self.receive(deadline)
            if message.get("id") == ident:
                if "error" in message:
                    raise RuntimeError(json.dumps(message["error"]))
                return message.get("result")

    def turn(self, thread, question=QUESTION):
        start = len(self.events)
        turn = self.call("turn/start", {"threadId": thread, "input": [{"type": "text", "text": question}]})["turn"]
        deadline = time.monotonic() + 150
        while True:
            message = self.receive(deadline)
            if message.get("method") == "turn/completed" and message["params"]["turn"]["id"] == turn["id"]:
                status = message["params"]["turn"]
                break
        events = self.events[start:]
        answers = [m["params"]["item"]["text"] for m in events
                   if m.get("method") == "item/completed" and m["params"]["item"]["type"] == "agentMessage"]
        usage = [m["params"]["tokenUsage"] for m in events if m.get("method") == "thread/tokenUsage/updated"]
        hooks = [m["params"]["run"] for m in events if m.get("method") == "hook/completed"]
        result = {"status": status["status"], "error": status.get("error"), "answers": answers,
                  "token_usage": usage[-1] if usage else None, "hooks": hooks}
        if status["status"] != "completed":
            raise RuntimeError(json.dumps(result))
        return result

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self.proc.stdin.close()
        self.proc.stdout.close()
        self.proc.stderr.close()


def fixture(name, mode="normal", mcp=False):
    root = ROOT / name
    home = root / "codex"
    memory_home = root / "memory ' $ home"
    # Misleading path is session metadata, never user biography.
    work = root / "historical-neuroscience-phd" / "alice-neuro-lab"
    for path in (home, memory_home, work):
        path.mkdir(parents=True)
    data = memory_home / "data"
    (data / "memory").mkdir(parents=True)
    config = {"schemaVersion": 2, "dataRoot": str(data),
              "remote": {"provider": "openai-compatible", "baseUrl": "http://127.0.0.1:1/v1",
                         "model": "never-called", "apiKeyEnv": "NO_MEMORY_KEY"},
              "disclosure": {"enabled": True, "allowedScopes": ["global"],
                             "allowedProvenance": ["user_explicit", "agent_observation"],
                             "maxExcerptBytes": 131072, "maxCandidateBytes": 131072, "maxTotalBytes": 131072},
              "writableScopes": ["global"],
              "scheduler": {"turnThreshold": 6, "byteThreshold": 16384, "idleMs": 120000,
                            "maxWaitMs": 600000, "leaseMs": 120000, "maxAttempts": 5}}
    (memory_home / "config.json").write_text(json.dumps(config))
    generated = subprocess.check_output([NODE, str(CLI), "codex-config"], text=True,
                                       env={**os.environ, "COMMON_MEMORY_HOME": str(memory_home)})
    parsed = tomllib.loads(generated)
    assert parsed["hooks"]["SessionStart"][0]["matcher"] == "^compact$"
    assert parsed["hooks"]["UserPromptSubmit"][0]["hooks"][0]["additionalContextLimit"] == 0
    if mode == "timeout":
        # Delay before running the real command; only in this disposable fixture.
        command = parsed["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
        generated = generated.replace(json.dumps(command), json.dumps("sleep 7; " + command))
    if mode == "disabled":
        generated = generated.replace("hooks = true", "hooks = false")
    (home / "common-memory.config.toml").write_text(generated)
    base = 'model="gpt-6-astra"\nmodel_reasoning_effort="medium"\ncheck_for_update_on_startup=false\n'
    if not args.live:
        base += 'model_provider="probe"\n'
    base += '[features]\nmemories=false\nplugins=false\napps=false\n[analytics]\nenabled=false\n'
    if not args.live:
        base += ('[model_providers.probe]\nname="Local synthetic provider"\nbase_url=' +
                 json.dumps("http://127.0.0.1:" + str(provider.server_port)) +
                 '\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n')
    if mcp:
        base += ('[mcp_servers.common_memory]\ncommand=' + json.dumps(NODE) +
                 '\nargs=' + json.dumps([str(CLI), "mcp", "--client-id", "codex-smoke", "--capability", "read", "--global"]) +
                 '\nenv={COMMON_MEMORY_HOME=' + json.dumps(str(memory_home)) +
                 '}\nenabled_tools=["memory_read","memory_status"]\n')
    # app-server 0.153.4 has no --profile flag: load identical generated hooks inline.
    # A separate real CLI exec below verifies the profile file itself.
    (home / "base.toml").write_text(base)
    inline = generated[generated.index("[[hooks."):]
    base = base.replace("[features]\n", "[features]\nhooks=" + ("false" if mode == "disabled" else "true") + "\n")
    (home / "config.toml").write_text(base + inline)
    if args.live:
        source = pathlib.Path(os.environ.get("CODEX_HOME", pathlib.Path.home() / ".codex")) / "auth.json"
        shutil.copyfile(source, home / "auth.json")
        os.chmod(home / "auth.json", 0o600)
    return home, work, data


def snapshot(data, version, long=False):
    research, language = ("underwater acoustics", "Python") if version == "A" else ("lattice dynamics", "Rust")
    text = ("# Profile\n\n## Imported background\nImported from a synthetic agent summary, not confirmed by the user: "
            "the current research field is " + research + ".\nThe preferred programming language is " + language + ".\n")
    if version == "A":
        text += "The souvenir badge code is Q7-29.\n"
    (data / "memory/profile.md").write_text(text)
    prefs = "# Preferences\n\n## Examples\n" + "".join(
        f"- Exercise {i:02}: prefer a concrete input, explanation of each component, and a check of the resulting output.\n"
        for i in range(60 if not long else 350))
    (data / "memory/preferences.md").write_text(prefs + "END_OF_COMPLETE_MEMORY\n")


def expected(data, work):
    out = subprocess.check_output([NODE, str(CLI), "codex-hook", "--home", str(data.parent)],
                                  input=json.dumps({"hook_event_name": "UserPromptSubmit", "cwd": str(work), "prompt": ""}),
                                  text=True)
    return json.loads(out)["hookSpecificOutput"]["additionalContext"]


def check_wire(start, current, present=True):
    requests = [r for r in wire[start:] if not r["path"].endswith("/compact")]
    assert requests, "No model request observed"
    memories = requests[-1]["snapshots"]
    if present:
        assert memories and memories[-1] == current, "Latest complete product snapshot missing or truncated: " + repr(memories)[-2000:]
    else:
        assert not memories, "Disabled/untrusted/timed-out hook injected memory"
    return {"snapshot_count": len(memories), "snapshot_bytes": [len(s.encode()) for s in memories],
            "snapshot_hashes": [hashlib.sha256(s.encode()).hexdigest() for s in memories],
            "input_bytes": requests[-1]["input_bytes"]}


def run_case(name, mode="normal", mcp=False):
    home, work, data = fixture(name, mode, mcp)
    if name == "normal":
        snapshot(data, "A")
        inline_config = (home / "config.toml").read_text()
        (home / "config.toml").write_text((home / "base.toml").read_text())
        start = len(wire)
        env = {k: v for k, v in os.environ.items() if k not in ("OPENAI_API_KEY", "OPENAI_BASE_URL")}
        try:
            result = subprocess.run([CODEX, "exec", "--profile", "common-memory", "--skip-git-repo-check",
                                     "--dangerously-bypass-hook-trust", QUESTION],
                                    cwd=work, env={**env, "CODEX_HOME": str(home)},
                                    capture_output=True, text=True, timeout=45)
            assert result.returncode == 0, result.stderr
            report["cli_stderr"] = result.stderr[-4000:]
            report["cli_profile"] = check_wire(start, expected(data, work))
        finally:
            (home / "config.toml").write_text(inline_config)
    client = Codex(home, work)
    case = {"name": name, "turns": []}
    report["cases"].append(case)
    try:
        thread = client.call("thread/start", {"cwd": str(work), "approvalPolicy": "never",
                            "sandbox": "read-only", "config": {"bypass_hook_trust": mode != "untrusted"}})["thread"]["id"]
        versions = ["A", "B", "B"] if mode == "normal" else ["A"]
        for version in versions:
            snapshot(data, version, long=mode == "long")
            start = len(wire)
            current = expected(data, work)
            result = client.turn(thread)
            case["turns"].append(result)
            if args.live and version == "A":
                inventory = client.call("mcpServerStatus/list", {"threadId": thread})
                assert {s["name"] for s in inventory["data"]} == ({"common_memory"} if mcp else set()), "Unexpected MCP servers"
                case["mcp_servers"] = [{"name": s["name"], "status": s.get("runtimeStatus"),
                                        "tools": sorted(t["name"] for t in s["tools"].values())}
                                       for s in inventory["data"]]
                if mcp:
                    server = case["mcp_servers"][0]
                    assert server["status"] == "connected", server
                    assert server["tools"] == ["memory_read", "memory_status"], server
            if not args.live:
                result["wire"] = check_wire(start, current, mode not in ("disabled", "untrusted", "timeout"))
            else:
                answer = json.loads(result["answers"][-1].removeprefix("```json").removesuffix("```").strip())
                assert answer["identity"] is None, answer
                assert answer["badge"] == ("Q7-29" if version == "A" else None), answer
                assert ("underwater acoustics" if version == "A" else "lattice dynamics") in answer["research"].lower(), answer
                assert answer["language"] == ("Python" if version == "A" else "Rust"), answer
                assert "agent" in str(answer["source"]).lower() and (
                    "unconfirm" in str(answer["source"]).lower() or re.search(r"not.{0,30}confirm", str(answer["source"]).lower())), answer
            print(json.dumps({"case": name, "version": version, "status": result["status"],
                              "wire": result.get("wire"), "answers": result["answers"]}, ensure_ascii=False), flush=True)
        if not args.live and mode == "normal":
            assert case["turns"][2]["wire"]["snapshot_hashes"][-2:] == [hashlib.sha256(current.encode()).hexdigest()] * 2
            # Restart app-server and resume durable thread, then refresh current memory.
            client.close()
            client = Codex(home, work)
            client.call("thread/resume", {"threadId": thread, "cwd": str(work),
                                         "config": {"bypass_hook_trust": True}})
            start = len(wire)
            result = client.turn(thread)
            case["resume"] = check_wire(start, current)
            # Explicit compaction, then next request. Check a SessionStart context as well as submit.
            start_events = len(client.events)
            client.call("thread/compact/start", {"threadId": thread})
            deadline = time.monotonic() + 60
            while True:
                msg = client.receive(deadline)
                if msg.get("method") == "turn/completed":
                    break
            start = len(wire)
            client.turn(thread)
            case["compact"] = check_wire(start, current)
            runs = [m["params"]["run"] for m in client.events[start_events:] if m.get("method") == "hook/completed"]
            case["compact_hooks"] = runs
            assert any(r.get("eventName") == "sessionStart" and r.get("status") == "completed" for r in runs), runs
            assert case["compact"]["snapshot_hashes"] == [hashlib.sha256(current.encode()).hexdigest()] * 2
        if mode == "timeout":
            assert any(h["status"] == "failed" for h in case["turns"][0]["hooks"]), "No timeout failure event"
        if args.live:
            counts = [t["token_usage"]["last"]["inputTokens"] for t in case["turns"]]
            case["input_tokens"] = counts
            assert counts[0] < counts[1] < counts[2], counts
        assert not (data / "runtime.sqlite").exists()
        assert not (data / "runtime").exists()
        case["passed"] = True
    except Exception as error:
        case["failure"] = repr(error)
        case["stderr_tail"] = "".join(client.errors)[-3000:]
        raise
    finally:
        client.close()


try:
    if args.live:
        run_case("hooks-alone")
        run_case("hooks-and-mcp", mcp=True)
    else:
        for name, mode in [("normal", "normal"), ("disabled", "disabled"), ("untrusted", "untrusted"),
                           ("timeout", "timeout"), ("long", "long")]:
            run_case(name, mode)
    report["passed"] = True
except Exception as error:
    report["passed"] = False
    report["failure"] = repr(error)
finally:
    # Store hook events and synthetic answers only, not request bodies or credentials.
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    shutil.rmtree(ROOT)
    if provider:
        provider.shutdown()
    print(json.dumps({"report": str(REPORT), "passed": report["passed"], "failure": report.get("failure")}), flush=True)
raise SystemExit(0 if report["passed"] else 1)
