#!/usr/bin/env python3
"""Probe the installed gh against a local fake GitHub API; no real credentials."""

import http.server
import json
import os
from pathlib import Path
import shutil
import socketserver
import subprocess
import tempfile
import threading


class UnixHTTPServer(socketserver.UnixStreamServer):
    allow_reuse_address = True


def main():
    executable = shutil.which("gh")
    if not executable:
        raise SystemExit("gh is required")
    requests = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.respond()

        def do_POST(self):
            self.respond()

        def respond(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            requests.append({
                "method": self.command,
                "host": self.headers.get("Host"),
                "path": self.path,
                "body": json.loads(body) if body else None,
                "uses_dummy_token": self.headers.get("Authorization") == "token local-probe-only",
            })
            headers = {}
            if self.path == "/user":
                result = {"login": "probe-user"}
            elif self.path == "/graphql":
                result = {"data": {"viewer": {"login": "probe-user"}}}
            elif self.path == "/repos/probe/example/issues?per_page=1":
                result = [{"number": 1}]
                headers["Link"] = '<https://api.github.com/repos/probe/example/issues?per_page=1&page=2>; rel="next"'
            elif self.path == "/repos/probe/example/issues?per_page=1&page=2":
                result = [{"number": 2}]
            else:
                result = {"message": "Not Found"}
            payload = json.dumps(result).encode()
            self.send_response(404 if self.path == "/missing" else 200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("X-RateLimit-Limit", "5000")
            self.send_header("X-RateLimit-Remaining", "4999")
            self.send_header("X-RateLimit-Resource", "core")
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(payload)

    with tempfile.TemporaryDirectory(prefix="ghproxy-probe-", dir="/tmp") as directory:
        root = Path(directory)
        socket_path = root / "api.sock"
        config_dir = root / "config"
        config_dir.mkdir()
        (config_dir / "config.yml").write_text("http_unix_socket: " + str(socket_path) + "\n")
        env = os.environ.copy()
        env.update({
            "GH_CONFIG_DIR": str(config_dir),
            "XDG_CACHE_HOME": str(root / "cache"),
            "XDG_STATE_HOME": str(root / "state"),
            "XDG_DATA_HOME": str(root / "data"),
            "GH_TOKEN": "local-probe-only",
            "GITHUB_TOKEN": "local-probe-only",
            "GH_ENTERPRISE_TOKEN": "local-probe-only",
            "GITHUB_ENTERPRISE_TOKEN": "local-probe-only",
            "GH_HOST": "github.com",
            "GH_REPO": "probe/example",
            "GH_PROMPT_DISABLED": "1",
            "GH_NO_UPDATE_NOTIFIER": "1",
            "GH_NO_EXTENSION_UPDATE_NOTIFIER": "1",
            "GH_TELEMETRY": "false",
            "GH_DEBUG": "0",
            "GH_PAGER": "cat",
            "NO_COLOR": "1",
            "HTTP_PROXY": "http://127.0.0.1:1",
            "HTTPS_PROXY": "http://127.0.0.1:1",
            "ALL_PROXY": "http://127.0.0.1:1",
            "http_proxy": "http://127.0.0.1:1",
            "https_proxy": "http://127.0.0.1:1",
            "all_proxy": "http://127.0.0.1:1",
            "NO_PROXY": "",
            "no_proxy": "",
        })
        server = UnixHTTPServer(str(socket_path), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        cases = [
            ("REST + jq", ["api", "user", "--jq", ".login"], 0, "probe-user"),
            ("GraphQL POST", ["api", "graphql", "-f", "query=query { viewer { login } }", "--jq", ".data.viewer.login"], 0, "probe-user"),
            ("absolute pagination URL", ["api", "repos/probe/example/issues?per_page=1", "--paginate", "--jq", ".[].number"], 0, "1\n2"),
            ("API error exit code", ["api", "missing"], 1, None),
        ]
        checks = []
        try:
            for name, args, code, output in cases:
                result = subprocess.run([executable] + args, env=env, cwd=directory,
                                        capture_output=True, text=True, timeout=10)
                assert result.returncode == code, (name, result.returncode, result.stderr)
                if output is not None:
                    assert result.stdout.strip() == output, (name, result.stdout)
                checks.append({"check": name, "passed": True})
            assert len(requests) == 5, requests
            assert all(r["host"] == "api.github.com" for r in requests), requests
            assert all(r["uses_dummy_token"] for r in requests), requests
            assert requests[1]["method"] == "POST" and requests[1]["path"] == "/graphql"
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        print(json.dumps({
            "gh_version": subprocess.check_output([executable, "--version"], env=env, text=True).splitlines()[0],
            "checks": checks,
            "requests": requests,
            "scope": "Local fake API only; does not prove all gh commands or live credential equivalence.",
        }, indent=2))


if __name__ == "__main__":
    main()
