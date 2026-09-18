"""Opt-in Linux hosts override; school HTTPS names and certificate checks stay intact."""

import fcntl
import http.client
import ipaddress
import os
import socket
import ssl
import stat
import sys


HOSTS = ("im1.infomentor.is", "minn.infomentor.is")
MARKER = b"infomentor-mcp alternate frontend"


def verify(address):
    context = ssl.create_default_context()
    for host, path in zip(HOSTS, ("/production/mentor/", "/")):
        with socket.create_connection((address, 443), timeout=10) as connection:
            with context.wrap_socket(connection, server_hostname=host) as tls:
                tls.sendall(
                    f"GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode()
                )
                response = http.client.HTTPResponse(tls)
                response.begin()
                if host == HOSTS[0]:
                    body = response.read(65537)
                    if response.status != 200 or b"__VIEWSTATE" not in body or b"password" not in body.lower():
                        raise ValueError("Alternate frontend did not return the school login form.")
                elif response.status != 302 or not response.getheader("Location", "").lower().startswith(
                    "/authentication/authentication/login"
                ):
                    raise ValueError("Alternate frontend did not return the parent login redirect.")


def discover():
    addresses = dict.fromkeys(
        item[4][0]
        for item in socket.getaddrinfo("api-im.infomentor.net", 443, socket.AF_INET, socket.SOCK_STREAM)
        if ipaddress.ip_address(item[4][0]).is_global
    )
    for address in list(addresses)[:4]:
        try:
            verify(address)
            return address
        except (OSError, ValueError, http.client.HTTPException):
            continue
    raise ValueError("Alternate frontend checks failed; hosts file unchanged.")


def rewrite(original, address):
    lines = []
    for line in original.splitlines(keepends=True):
        entry, _, comment = line.partition(b"#")
        fields = entry.split()
        names = [field.lower().rstrip(b".") for field in fields[1:]]
        if comment.strip() == MARKER:
            if len(fields) != 3 or set(names) != {host.encode() for host in HOSTS}:
                raise ValueError("Modified managed hosts entry; review /etc/hosts before retrying.")
            ipaddress.ip_address(fields[0].decode("ascii"))
            continue
        if address and any(host.encode() in names for host in HOSTS):
            raise ValueError("Existing InfoMentor hosts entry; review /etc/hosts before retrying.")
        lines.append(line)
    result = b"".join(lines)
    if address:
        if result and not result.endswith(b"\n"):
            result += b"\n"
        result += f"{address} {' '.join(HOSTS)} # ".encode() + MARKER + b"\n"
    return result


def configure(action, path="/etc/hosts"):
    # Keep the inode: /etc/hosts is often a bind mount in hosted VMs.
    with os.fdopen(os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK), "r+b") as hosts:
        fcntl.flock(hosts, fcntl.LOCK_EX)
        info = os.fstat(hosts.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022 or info.st_nlink != 1:
            raise ValueError("Hosts file must be a regular, owner-controlled file without shared write access.")
        original = hosts.read(1024 * 1024 + 1)
        if len(original) > 1024 * 1024:
            raise ValueError("Hosts file is unexpectedly large; review it before retrying.")
        address = discover() if action == "install" else None
        result = rewrite(original, address)
        if result != original:
            hosts.seek(0)
            if hosts.read(1024 * 1024 + 1) != original or os.stat(path, follow_symlinks=False).st_ino != info.st_ino:
                raise ValueError("Hosts file changed during verification; retry after other edits finish.")
            try:
                hosts.seek(0)
                hosts.write(result)
                hosts.truncate()
                hosts.flush()
                os.fsync(hosts.fileno())
            except OSError:
                hosts.seek(0)
                hosts.write(original)
                hosts.truncate()
                hosts.flush()
                os.fsync(hosts.fileno())
                raise
    print(f"Verified InfoMentor direct route: {address}" if address else "Removed the managed InfoMentor direct route.")


if __name__ == "__main__":
    try:
        if sys.argv[1:] not in (["install"], ["remove"]):
            raise ValueError("Usage: direct-route.py install|remove")
        if sys.platform != "linux" or os.geteuid() != 0:
            raise ValueError("Direct-route setup requires Linux and administrator access.")
        configure(sys.argv[1])
    except (OSError, ValueError, http.client.HTTPException) as error:
        print(f"InfoMentor direct-route setup failed: {error}", file=sys.stderr)
        sys.exit(1)
