"""Offline check: python3 -I scripts/direct-route.test.py"""

import errno
from functools import partial
import http.server
import importlib.util
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("direct_route", Path(__file__).with_name("direct-route.py"))
route = importlib.util.module_from_spec(spec)
spec.loader.exec_module(route)
original = b"127.0.0.1 localhost\n::1 localhost ip6-localhost\n# retained comment\n"
address = "8.8.8.8"
installed = route.rewrite(original, address)
assert route.rewrite(installed, address) == installed
assert route.rewrite(installed, None) == original
assert route.rewrite(installed, "1.1.1.1") == route.rewrite(original, "1.1.1.1")
assert route.rewrite(b"127.0.0.1 localhost", address).startswith(b"127.0.0.1 localhost\n")

for conflicting in (
    b"1.2.3.4 im1.infomentor.is\n",
    b"1.2.3.4 other MINN.INFOMENTOR.IS.\n",
    b"1.2.3.4 im1.infomentor.is other # infomentor-mcp alternate frontend\n",
):
    try:
        route.rewrite(original + conflicting, address)
        raise AssertionError("Conflicting host entry accepted")
    except ValueError:
        pass
assert route.rewrite(original + b"1.2.3.4 im1.infomentor.is\n", None) == original + b"1.2.3.4 im1.infomentor.is\n"

with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "hosts"
    path.write_bytes(original)
    path.chmod(0o644)
    inode = path.stat().st_ino
    with patch.object(route, "discover", return_value=address), patch.object(route, "verify", return_value=None):
        route.configure("install", path)
        route.configure("install", path)
        assert path.read_bytes() == installed
        assert path.stat().st_ino == inode
        assert path.stat().st_mode & 0o777 == 0o644
    with patch.object(route, "discover", return_value=None), patch.object(route, "verify", side_effect=OSError("down")):
        try:
            route.configure("install", path)
            raise AssertionError("Failed preflight accepted")
        except ValueError:
            pass
        assert path.read_bytes() == installed
    route.configure("remove", path)
    assert path.read_bytes() == original
    with patch.object(route, "discover", return_value=address), patch.object(route.os, "fsync", side_effect=[OSError("write failed"), None]):
        try:
            route.configure("install", path)
            raise AssertionError("Failed write accepted")
        except OSError:
            pass
        assert path.read_bytes() == original

    def concurrent_edit(failures):
        path.write_bytes(original + b"127.0.0.2 another-host\n")
        return address

    with patch.object(route, "discover", side_effect=concurrent_edit):
        try:
            route.configure("install", path)
            raise AssertionError("Concurrent edit overwritten")
        except ValueError:
            pass
        assert path.read_bytes() == original + b"127.0.0.2 another-host\n"
    path.write_bytes(original)
    for unsafe in ("symlink", "hardlink", "writable"):
        other = Path(directory) / unsafe
        if unsafe == "symlink":
            other.symlink_to(path)
        elif unsafe == "hardlink":
            os.link(path, other)
        else:
            other.write_bytes(original)
            other.chmod(0o666)
        try:
            route.configure("remove", other)
            raise AssertionError(f"Unsafe {unsafe} accepted")
        except (OSError, ValueError):
            pass
        assert path.read_bytes() == original
        other.unlink()

# DNS candidates stay public IPv4; a failed candidate does not prevent fallback.
with patch.object(route.socket, "getaddrinfo", return_value=[
    (0, 0, 0, "", ("127.0.0.1", 443)),
    (0, 0, 0, "", ("8.8.8.8", 443)),
    (0, 0, 0, "", ("1.1.1.1", 443)),
]), patch.object(route, "verify", side_effect=[OSError("unreachable"), None]) as verify:
    failures = []
    assert route.discover(failures) == "1.1.1.1"
    assert failures == ["127.0.0.1: skipped: not a public address (a local proxy or VPN DNS may be answering)", "8.8.8.8: OSError: unreachable"]
    assert [call.args[0] for call in verify.call_args_list] == ["8.8.8.8", "1.1.1.1"]

# Existing-entry parsing: one address for both names, or a refusal.
assert route.existing_entry(original) is None
assert route.existing_entry(installed) == (address, True)
assert route.existing_entry(original + b"1.2.3.4 im1.infomentor.is minn.infomentor.is\n") == ("1.2.3.4", False)
assert route.existing_entry(original + b"1.2.3.4 im1.infomentor.is\n1.2.3.4 MINN.infomentor.is.\n") == ("1.2.3.4", False)
for ambiguous in (
    b"1.2.3.4 im1.infomentor.is\n",
    b"1.2.3.4 im1.infomentor.is\n5.6.7.8 minn.infomentor.is\n",
    b"1.2.3.4 im1.infomentor.is minn.infomentor.is\n::1 im1.infomentor.is\n",
    b"1.2.3.4 im1.infomentor.is minn.infomentor.is\n" + installed.splitlines(keepends=True)[-1],
    b"not-an-address im1.infomentor.is minn.infomentor.is\n",
    b"1.2.3.4 im1.infomentor.is other # infomentor-mcp alternate frontend\n",
):
    try:
        route.existing_entry(original + ambiguous)
        raise AssertionError(f"Ambiguous entry accepted: {ambiguous!r}")
    except ValueError:
        pass

# A real loopback HTTPS fake for both school names, trusted only through an injected context.
with tempfile.TemporaryDirectory() as directory:
    folder = Path(directory)
    (folder / "openssl.cnf").write_text(
        "[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = direct-route test\n"
        "[ca]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign\n"
        "subjectKeyIdentifier = hash\n"
        "[leaf]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature\n"
        "extendedKeyUsage = serverAuth\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid\n"
        "subjectAltName = DNS:im1.infomentor.is,DNS:minn.infomentor.is\n"
    )
    key = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-config", "openssl.cnf"]
    for command in (
        ["openssl", "req", "-x509", *key, "-extensions", "ca", "-days", "2", "-keyout", "ca.key", "-out", "ca.pem"],
        ["openssl", "req", "-new", *key, "-keyout", "leaf.key", "-out", "leaf.csr"],
        ["openssl", "x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "2",
         "-days", "2", "-extfile", "openssl.cnf", "-extensions", "leaf", "-out", "leaf.pem"],
    ):
        subprocess.run(command, cwd=folder, check=True, capture_output=True, stdin=subprocess.DEVNULL)
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(folder / "leaf.pem", folder / "leaf.key")

    class Frontend(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            host = self.headers["Host"]
            if self.server.broken:
                self.send_response(503)
                self.end_headers()
            elif host == "im1.infomentor.is" and self.path == "/production/mentor/":
                body = b'<form><input name="__VIEWSTATE"><input type="Password"></form>'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif host == "minn.infomentor.is" and self.path == "/":
                self.send_response(302)
                self.send_header("Location", "/Authentication/Authentication/Login?x=1")
                self.end_headers()
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, *args):
            pass

    def frontend(broken):
        # Bound and listening before the thread starts, so connections queue instead of racing.
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Frontend)
        server.socket = server_context.wrap_socket(server.socket, server_side=True)
        server.broken = broken
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    working, broken = frontend(False), frontend(True)
    ports = {
        "198.51.100.10": working.server_address[1],
        "198.51.100.20": broken.server_address[1],
        "8.8.4.4": None,  # Refused without opening a socket, so no port can be reused under the test.
        "1.0.0.1": working.server_address[1],
    }

    def connect(target, timeout):
        assert target[1] == 443 and target[0] in ports, f"Unexpected connection to {target}"
        if ports[target[0]] is None:
            raise ConnectionRefusedError(errno.ECONNREFUSED, os.strerror(errno.ECONNREFUSED))
        return socket.create_connection(("127.0.0.1", ports[target[0]]), timeout=timeout)

    trusted = ssl.create_default_context(cafile=str(folder / "ca.pem"))
    loopback_verify = partial(route.verify, context=trusted, connect=connect)
    route.verify("198.51.100.10", context=trusted, connect=connect)
    try:
        route.verify("198.51.100.10", connect=connect)
        raise AssertionError("Fake frontend trusted without the injected context")
    except ssl.SSLCertVerificationError:
        pass
    resolve = socket.getaddrinfo

    def discovery(*answers):
        # Only the discovery name is faked; loopback connections still resolve normally.
        def lookup(name, *args):
            if name != "api-im.infomentor.net":
                return resolve(name, *args)
            if not answers:
                raise socket.gaierror(-2, "Name or service not known")
            return [(0, 0, 0, "", (answer, 443)) for answer in answers]

        return patch.object(route.socket, "getaddrinfo", side_effect=lookup)

    dns_down = discovery()
    candidates = discovery("8.8.4.4", "1.0.0.1")
    managed = lambda ip: original + f"{ip} im1.infomentor.is minn.infomentor.is # ".encode() + route.MARKER + b"\n"
    by_hand = lambda ip: original + f"{ip} im1.infomentor.is minn.infomentor.is\n".encode()

    def install(content, discovery, checker=loopback_verify, action="install"):
        path = folder / "hosts"
        path.write_bytes(content)
        path.chmod(0o644)
        os.utime(path, ns=(1, 1))
        before = path.stat()
        with patch.object(route, "verify", checker), discovery:
            try:
                route.configure(action, path)
                error = None
            except ValueError as failure:
                error = str(failure)
        after = path.stat()
        written = (after.st_mtime_ns, after.st_ino) != (before.st_mtime_ns, before.st_ino)
        return path.read_bytes(), written, error

    # Case 1: a working managed entry is kept while discovery is down.
    content, written, error = install(managed("198.51.100.10"), dns_down)
    assert error is None, f"Case 1: working managed entry refused: {error}"
    assert content == managed("198.51.100.10") and not written, "Case 1: hosts file changed"

    # Case 2: a broken managed entry with discovery down fails, naming each address and error.
    content, written, error = install(managed("198.51.100.20"), dns_down)
    assert error is not None, "Case 2: broken route accepted"
    assert content == managed("198.51.100.20") and not written, "Case 2: hosts file changed"
    assert "existing managed entry 198.51.100.20: ValueError: Frontend did not return the school login form (HTTP 503)." in error, f"Case 2: {error}"
    assert "api-im.infomentor.net lookup: gaierror: [Errno -2] Name or service not known" in error, f"Case 2: {error}"
    content, written, error = install(managed("198.51.100.20"), discovery("8.8.4.4"))
    assert error is not None and content == managed("198.51.100.20") and not written, "Case 2: hosts file changed"
    assert error.splitlines()[1:] == [
        "  existing managed entry 198.51.100.20: ValueError: Frontend did not return the school login form (HTTP 503).",
        f"  8.8.4.4: ConnectionRefusedError: [Errno {errno.ECONNREFUSED}] {os.strerror(errno.ECONNREFUSED)}",
    ], f"Case 2: {error}"

    # A fake-IP answer from a local proxy or VPN DNS is skipped and named, not pinned.
    content, written, error = install(managed("198.51.100.20"), discovery("198.18.0.1"))
    assert error is not None and content == managed("198.51.100.20") and not written, "Fake-IP: hosts file changed"
    assert error.splitlines()[1:] == [
        "  existing managed entry 198.51.100.20: ValueError: Frontend did not return the school login form (HTTP 503).",
        "  198.18.0.1: skipped: not a public address (a local proxy or VPN DNS may be answering)",
        "  api-im.infomentor.net lookup: no public IPv4 address",
    ], f"Fake-IP: {error}"

    # Case 3: a working hand-written entry is kept as it is, with no marker.
    content, written, error = install(by_hand("198.51.100.10"), dns_down)
    assert error is None, f"Case 3: working hand-written entry refused: {error}"
    assert content == by_hand("198.51.100.10") and not written and route.MARKER not in content, "Case 3: hosts file changed"

    # A broken managed entry is replaced by a working discovery candidate after a refused one.
    content, written, error = install(managed("198.51.100.20"), candidates)
    assert error is None and content == managed("1.0.0.1"), f"Managed entry not replaced: {error}"

    # A broken hand-written entry is refused even when discovery finds a working address.
    content, written, error = install(by_hand("198.51.100.20"), candidates)
    assert error is not None and "Verified alternate address: 1.0.0.1" in error and "Review /etc/hosts" in error, error
    assert "existing hand-written entry 198.51.100.20: ValueError" in error and "8.8.4.4: ConnectionRefusedError" in error, error
    assert content == by_hand("198.51.100.20") and not written, "Broken hand-written entry rewritten"

    # Ambiguous entries are refused before any verification or discovery.
    ambiguous = original + b"198.51.100.10 im1.infomentor.is\n198.51.100.20 minn.infomentor.is\n"
    spy = Mock(side_effect=AssertionError("verified an ambiguous entry"))
    no_lookup = patch.object(route.socket, "getaddrinfo", side_effect=AssertionError("discovery ran"))
    content, written, error = install(ambiguous, no_lookup, spy)
    assert error is not None and error.startswith("Ambiguous") and not spy.called, error
    assert content == ambiguous and not written, "Ambiguous entry rewritten"

    # Remove keeps a hand-written entry.
    content, written, error = install(by_hand("198.51.100.10"), no_lookup, spy, "remove")
    assert error is None and content == by_hand("198.51.100.10") and not written and not spy.called, error

    # Case 4: a bare CR does not end a hosts line, so a managed-looking entry after it is still a comment.
    commented = original + b"# disabled\r198.51.100.10 im1.infomentor.is minn.infomentor.is # " + route.MARKER + b"\r\n"
    content, written, error = install(commented, dns_down)
    assert error is not None and error.startswith("Alternate frontend checks failed"), f"Case 4: commented entry kept: {error}"
    assert content == commented and not written, "Case 4: hosts file changed"
    content, written, error = install(commented, no_lookup, spy, "remove")
    assert error is None and content == commented and not written, f"Case 4: commented bytes removed: {error}"
    assert route.rewrite(commented, "1.0.0.1") == commented + b"1.0.0.1 im1.infomentor.is minn.infomentor.is # " + route.MARKER + b"\n"
    for server in (working, broken):
        server.shutdown()
        server.server_close()

print("Direct-route offline checks passed.")
