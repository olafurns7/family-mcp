"""Offline check: python3 -I scripts/direct-route.test.py"""

import importlib.util
import os
from pathlib import Path
import tempfile
from unittest.mock import patch


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
    with patch.object(route, "discover", return_value=address):
        route.configure("install", path)
        route.configure("install", path)
        assert path.read_bytes() == installed
        assert path.stat().st_ino == inode
        assert path.stat().st_mode & 0o777 == 0o644
    with patch.object(route, "discover", side_effect=ValueError("TLS preflight failed")):
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

    def concurrent_edit():
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
    assert route.discover() == "1.1.1.1"
    assert [call.args[0] for call in verify.call_args_list] == ["8.8.8.8", "1.1.1.1"]

print("Direct-route offline checks passed.")
