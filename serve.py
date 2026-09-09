#!/usr/bin/env python3
"""
HTTPS server for serving the Yoga Pose Tracker PWA.

Browsers will not open a camera on a plain http:// address, so this generates a
self-signed certificate and serves over TLS. That is the whole reason it exists
— any static file server will do otherwise.

Usage:
    python3 serve.py
"""
import errno
import functools
import http.server
import os
import shutil
import socket
import ssl
import subprocess
import sys

PORT = 8443
PORT_ATTEMPTS = 12

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, "yoga_app")
CERT_FILE = os.path.join(HERE, ".self_signed_cert.pem")
KEY_FILE = os.path.join(HERE, ".self_signed_key.pem")

# Regenerate a day before expiry rather than at it, so a session that starts
# tonight does not stop working at midnight.
CERT_MARGIN_SECONDS = 24 * 60 * 60


def get_local_ip():
    """The address this machine has on the local network, for the phone to use."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))          # no packets are sent; this just picks a route
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "localhost"


def cert_still_valid(openssl):
    """
    Is the certificate on disk one we can still serve with?

    It used to be enough for the file to exist, which meant an expired
    certificate was reused forever — and the failure lands in the browser as a
    security error with nothing here to explain it.
    """
    if not (os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE)):
        return False
    if openssl is None:
        return True     # cannot check without openssl; an old cert beats none
    checked = subprocess.run(
        [openssl, "x509", "-in", CERT_FILE, "-noout",
         "-checkend", str(CERT_MARGIN_SECONDS)],
        capture_output=True,
    )
    return checked.returncode == 0


def generate_cert():
    """Make a self-signed certificate, unless a usable one is already here."""
    openssl = shutil.which("openssl")

    if cert_still_valid(openssl):
        return

    if openssl is None:
        sys.exit(
            "\n  Can't find `openssl`, and it is needed to make the HTTPS\n"
            "  certificate this server runs on. Browsers will not open a camera\n"
            "  on a plain http:// address, so the certificate is not optional.\n"
            "\n"
            "  macOS ships with openssl; if it has gone missing, `brew install\n"
            "  openssl` puts it back. On Debian or Ubuntu, `apt install openssl`.\n"
        )

    if os.path.exists(CERT_FILE):
        print("🔐 The certificate has expired, or is about to — making a new one...")
    else:
        print("🔐 Generating a self-signed SSL certificate...")

    try:
        subprocess.run(
            [openssl, "req", "-x509", "-newkey", "rsa:2048",
             "-keyout", KEY_FILE,
             "-out", CERT_FILE,
             "-days", "365",
             "-nodes",
             "-subj", "/CN=YogaPoseTracker"],
            check=True, capture_output=True,
        )
    except subprocess.CalledProcessError as err:
        detail = (err.stderr or b"").decode(errors="replace").strip()
        sys.exit(f"\n  openssl could not generate a certificate:\n\n{detail}\n")

    print("✅ Certificate generated.")


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """
    Serve everything with caching turned off.

    Without this an edited file sits behind the browser's own cache and the
    phone keeps replaying an old build — and since the app installs a service
    worker, the two caches compound into something that needs a hard reload to
    shift. The app's own service worker is network-first for its code, so it
    picks up whatever this serves.
    """

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def bind(handler):
    """
    Take the first free port at or above PORT.

    A busy port used to come out as a bare OSError traceback, which is a poor
    way to say "the last copy of this server is still running".
    """
    for port in range(PORT, PORT + PORT_ATTEMPTS):
        try:
            return http.server.HTTPServer(("0.0.0.0", port), handler), port
        except OSError as err:
            if err.errno in (errno.EADDRINUSE, errno.EACCES):
                print(f"  Port {port} is taken, trying {port + 1}...")
                continue
            sys.exit(f"\n  Could not open port {port}: {err}\n")

    sys.exit(
        f"\n  Ports {PORT} to {PORT + PORT_ATTEMPTS - 1} are all in use.\n"
        f"  Another copy of this server is probably still running:\n"
        f"      pkill -f serve.py\n"
    )


def main():
    generate_cert()

    handler = functools.partial(NoCacheHandler, directory=DIR)
    server, port = bind(handler)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    try:
        context.load_cert_chain(CERT_FILE, KEY_FILE)
    except ssl.SSLError as err:
        sys.exit(
            f"\n  The certificate and key on disk do not load: {err}\n"
            f"  Deleting them will make a fresh pair:\n"
            f"      rm {CERT_FILE} {KEY_FILE}\n"
        )
    server.socket = context.wrap_socket(server.socket, server_side=True)

    local_ip = get_local_ip()

    print()
    print("=" * 56)
    print("  🧘 Yoga Pose Tracker — HTTPS Server Running")
    print("=" * 56)
    print()
    print("  📱 Open this URL on your phone:")
    print()
    print(f"     https://{local_ip}:{port}")
    print()
    print("  💻 Or on this Mac:")
    print(f"     https://localhost:{port}")
    print()
    print("  ⚠️  Your browser will warn about the self-signed")
    print("     certificate. Tap 'Advanced' → 'Proceed' to")
    print("     continue. This is safe on your local network.")
    print()
    print("  Press Ctrl+C to stop the server.")
    print("=" * 56)
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 Server stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
