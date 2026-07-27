#!/usr/bin/env python3
"""
HTTPS server for serving the Yoga Pose Tracker PWA.
Generates a self-signed certificate on the fly so Android Chrome
allows camera access over the local network.

Usage:
    python3 serve.py
"""
import http.server
import ssl
import subprocess
import os
import socket

PORT = 8443
DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "yoga_app")
CERT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".self_signed_cert.pem")
KEY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".self_signed_key.pem")


def get_local_ip():
    """Get the local IP address of this machine on the WiFi network."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "localhost"


def generate_cert():
    """Generate a self-signed certificate if one doesn't exist."""
    if os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE):
        return

    print("🔐 Generating self-signed SSL certificate...")
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", KEY_FILE,
        "-out", CERT_FILE,
        "-days", "365",
        "-nodes",
        "-subj", "/CN=YogaPoseTracker",
    ], check=True, capture_output=True)
    print("✅ Certificate generated.")


def main():
    generate_cert()

    os.chdir(DIR)

    handler = http.server.SimpleHTTPRequestHandler
    server = http.server.HTTPServer(("0.0.0.0", PORT), handler)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(CERT_FILE, KEY_FILE)
    server.socket = context.wrap_socket(server.socket, server_side=True)

    local_ip = get_local_ip()

    print()
    print("=" * 56)
    print("  🧘 Yoga Pose Tracker — HTTPS Server Running")
    print("=" * 56)
    print()
    print(f"  📱 Open this URL on your phone:")
    print()
    print(f"     https://{local_ip}:{PORT}")
    print()
    print(f"  💻 Or on this Mac:")
    print(f"     https://localhost:{PORT}")
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
        server.server_close()


if __name__ == "__main__":
    main()
