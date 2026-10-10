# Real-session renewal check

Owner only: use a release binary built without `test-origin` and an already signed-in
Mac session. This check reads school state and renews the encrypted session cookies;
it submits no absence. Stop other Inna servers and avoid browser or CLI activity on
the account during the check, so only this server can extend the session. Do not
sign in solely for the agent or share any cookie exports, files or command output.

Run from the repository root, replacing the binary path if needed. It initializes
one read-only MCP connection, makes **no tool calls** for 71 minutes, closes it,
then checks authentication with `auth status`. Subprocess output is consumed without
printing it; the script prints only yes/no and UTC timestamps. A missing session
fails the initial check. Repeat with `--no-keep-alive` to test mandatory renewal.

```sh
python3 - packages/inna-mcp/release/native/inna-mcp <<'PY'
import datetime
import json
import subprocess
import sys

binary = sys.argv[1]

def stamp(name, passed):
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    print(f"{name}={'yes' if passed else 'no'} {now}", flush=True)

def authenticated():
    check = subprocess.run([binary, "auth", "status"], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=90)
    return check.returncode == 0 and check.stdout.startswith(b"Inna session is authenticated.")

initial = authenticated()
stamp("authenticated_start", initial)
if not initial:
    sys.exit(1)

server = subprocess.Popen([binary, "serve"], stdin=subprocess.PIPE,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
idle = False
try:
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "owner-session-check", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
    ]
    for message in messages:
        server.stdin.write((json.dumps(message) + "\n").encode())
    server.stdin.flush()
    try:
        server.wait(timeout=71 * 60)
    except subprocess.TimeoutExpired:
        idle = True
finally:
    server.stdin.close()
    try:
        server.wait(timeout=90)
    except subprocess.TimeoutExpired:
        server.terminate()
        server.wait(timeout=40)

stamp("idle_71_minutes", idle and server.returncode == 0)
final = authenticated()
stamp("authenticated_end", final)
sys.exit(0 if idle and server.returncode == 0 and final else 1)
PY
```

Passing demonstrates that this real session stayed usable across this idle window.
It does not establish Inna's universal TTL or prove which individual GET extended
the session. Offline fake-Inna tests prove the cadence and maximum-age checks;
the live service can still reject renewal or end a session for other reasons.
