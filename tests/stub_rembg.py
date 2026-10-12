#!/usr/bin/env python3
"""Minimal stand-in for rembg's `rembg s` server, just for testing the editor wiring.
Mirrors the real API: POST /api/remove, multipart field `file`, returns image/png, CORS *.
Returns 400 if the field is not named `file` (so a passing client proves the field name)."""
import http.server, socketserver, struct, zlib, sys

def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

def png_rgba(w, h):
    rows = bytearray()
    for y in range(h):
        rows.append(0)
        for x in range(w):
            if x < w // 2:
                rows += bytes((0, 0, 0, 0))          # transparent half
            else:
                rows += bytes((10, 200, 90, 255))    # opaque green half
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(rows), 6))
            + chunk(b'IEND', b''))

BODY = png_rgba(200, 150)
STATE = {"ok": 0, "bad": 0}

class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_GET(self):
        if self.path == '/stats':
            b = ('{"ok":%d,"bad":%d}' % (STATE["ok"], STATE["bad"])).encode()
            self.send_response(200); self._cors()
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b); return
        self.send_response(404); self._cors(); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(n) if n else b''
        if self.path != '/api/remove' or b'name="file"' not in body:
            STATE["bad"] += 1
            self.send_response(400); self._cors(); self.end_headers(); return
        STATE["ok"] += 1
        self.send_response(200); self._cors()
        self.send_header('Content-Type', 'image/png')
        self.send_header('Content-Length', str(len(BODY))); self.end_headers(); self.wfile.write(BODY)
    def log_message(self, *a): pass

class Srv(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

port = int(sys.argv[1]) if len(sys.argv) > 1 else 7999
Srv(('0.0.0.0', port), H).serve_forever()
