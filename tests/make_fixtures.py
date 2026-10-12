#!/usr/bin/env python3
"""Generate the PNG fixtures used by tests/e2e.ts.

Deterministic, stdlib only. Usage:
    python3 tests/make_fixtures.py [outdir]     # default: tests/fixtures

Each fixture exists for a specific reason, noted below - they are not arbitrary.
"""
import os
import struct
import sys
import zlib


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)


def write_png(path: str, w: int, h: int, shade) -> int:
    rows = bytearray()
    for y in range(h):
        rows.append(0)                       # filter: none
        for x in range(w):
            rows += bytes(shade(x, y, w, h))
    blob = (b'\x89PNG\r\n\x1a\n'
            + _chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + _chunk(b'IDAT', zlib.compress(bytes(rows), 6))
            + _chunk(b'IEND', b''))
    with open(path, 'wb') as fh:
        fh.write(blob)
    return len(blob)


def quadrant(x, y, w, h):
    """Four flat quadrants: lets tests assert exact pixels and coordinate mapping."""
    return (255 if x < w // 2 else 20, 255 if y < h // 2 else 20, 128)


def hifreq(x, y, w, h):
    """4px checkerboard + speckle. A flat or smooth image is a bad fixture for
    Pixelate/Blur - averaging a solid area changes nothing measurable."""
    c = (x // 4 + y // 4) % 2
    r, g, b = (232, 208, 60) if c else (24, 32, 210)
    if (x * 7 + y * 13) % 97 < 3:
        r, g = (r + 120) % 256, (g + 60) % 256
    return (r, g, b)


def small(x, y, w, h):
    """Small 10px checkerboard, pasted as layers so resize handles land inside the canvas."""
    return (250, 90, 20) if (x // 10 + y // 10) % 2 else (20, 120, 250)


FIXTURES = {
    'edtest.png':  (1600, 1200, quadrant),
    'edgrad.png':  (1600, 1200, hifreq),
    'edsmall.png': (300, 200, small),
}


def main() -> None:
    default = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
    out = sys.argv[1] if len(sys.argv) > 1 else default
    os.makedirs(out, exist_ok=True)
    for name, (w, h, shade) in FIXTURES.items():
        size = write_png(os.path.join(out, name), w, h, shade)
        print(f'{name:14s} {w}x{h}  {size} bytes')
    print('fixtures written to', out)


if __name__ == '__main__':
    main()
