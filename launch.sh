#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CONDUCTOR launcher — no-cache dev server on port 2610
# Usage: ./launch.sh          foreground (Ctrl+C to stop)
#        ./launch.sh bg       background, logs to /tmp/conductor_server.log
#        ./launch.sh stop     stop any server on 2610
# ─────────────────────────────────────────────────────────────────────────────
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=2610
URL="http://127.0.0.1:${PORT}/index.html"
SERVER_PY="${PROJECT_DIR}/.conductor_server.py"

stop_existing() {
  if ss -tlnp 2>/dev/null | grep -q ":${PORT}"; then
    echo "→ Stopping existing process on port ${PORT}…"
    pkill -f "conductor_server.py ${PORT}" 2>/dev/null || true
    pkill -f "http.server ${PORT}"         2>/dev/null || true
    for _ in 1 2 3 4 5; do
      ss -tlnp 2>/dev/null | grep -q ":${PORT}" || break
      sleep 0.3
    done
  fi
}

if [ "${1}" = "stop" ]; then
  stop_existing
  echo "→ Server on port ${PORT} stopped."
  exit 0
fi

cat > "${SERVER_PY}" << 'PY'
#!/usr/bin/env python3
"""CONDUCTOR dev server — no caching, so reloads always pull fresh code."""
import http.server, os, sys, socketserver

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma',  'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()
    def log_message(self, fmt, *args):
        try:
            code = args[1] if len(args) > 1 else ''
            if str(code).startswith(('4', '5')):
                sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))
        except Exception:
            pass

class ReusableServer(socketserver.TCPServer):
    allow_reuse_address = True

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 2610
    os.chdir(sys.argv[2] if len(sys.argv) > 2 else '.')
    print(f"\n  ◈ CONDUCTOR  →  http://127.0.0.1:{port}/index.html")
    print(f"    listener   →  http://127.0.0.1:{port}/test.html\n")
    print(f"  serving: {os.getcwd()}")
    print(f"  stop:    Ctrl+C\n")
    with ReusableServer(('127.0.0.1', port), NoCacheHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  → stopped\n")
PY
chmod +x "${SERVER_PY}"

stop_existing

if [ "${1}" = "bg" ]; then
  nohup python3 "${SERVER_PY}" "${PORT}" "${PROJECT_DIR}" > /tmp/conductor_server.log 2>&1 &
  PID=$!
  sleep 0.6
  if kill -0 "${PID}" 2>/dev/null; then
    echo ""
    echo "  ◈ CONDUCTOR launched in background (pid ${PID})"
    echo "     →  ${URL}"
    echo "     log:  /tmp/conductor_server.log"
    echo "     stop: ./launch.sh stop"
    echo ""
  else
    echo "✗ Server failed to start — check /tmp/conductor_server.log"
    cat /tmp/conductor_server.log
    exit 1
  fi
  exit 0
fi

exec python3 "${SERVER_PY}" "${PORT}" "${PROJECT_DIR}"
