# EasyEdit's patched rembg sidecar.
#
# Upstream `danielgatis/rembg:2.0.86` installs `rembg[cpu,cli]`. The `cli`
# extra pulls gradio, and gradio still pins `pillow<13.0`. That leaves the
# image on Pillow 12.3.0 (41 advisories, five critical) and Brotli 1.2.0
# (CVE-2026-111497, reachable through `GET /api/remove?url=`).
#
# The server is started with `--no-ui` (see compose.yaml), so gradio is never
# imported. Removing it lifts the Pillow pin. Brotli is only here for
# gradio/httpx, so it is removed rather than upgraded; aiohttp treats Brotli
# as optional and simply stops advertising `br`.
#
# Build from the repository root:
#   scripts/publish.sh
# or directly:
#   docker build -t easyedit-rembg ./rembg
FROM docker.io/danielgatis/rembg:2.0.86@sha256:8b7936a9db723b7cfffe2c2d514d6cc17b7e43fca677bdaeed65e7f788aeab68

LABEL org.opencontainers.image.title="EasyEdit rembg" \
      org.opencontainers.image.description="Patched rembg sidecar for EasyEdit" \
      org.opencontainers.image.source="https://github.com/ShadyHippo/EasyEdit-Photos" \
      org.opencontainers.image.version="2.0.86-p1"

# --no-ui means gradio is dead weight; dropping it allows Pillow 13.
# rembg pins python-multipart <0.0.22; 0.0.31 is the first release with the
# 2026 multipart DoS/smuggling fixes. Starlette 0.52.1 supports the new
# `python_multipart` namespace, so the override is API-compatible (asserted
# below), but `pip check` will still flag rembg's stale metadata.
RUN pip uninstall -y gradio gradio-client brotli && \
    pip install --no-cache-dir --no-deps \
      "pillow==13.0.0" \
      "python-multipart==0.0.31"

# Fail the build rather than publish an image with the old, vulnerable set.
RUN python - <<'PY'
import importlib.metadata as m
from PIL import __version__ as pillow_version

assert pillow_version == "13.0.0", pillow_version
assert m.version("python-multipart") == "0.0.31", m.version("python-multipart")

try:
    m.version("brotli")
except m.PackageNotFoundError:
    pass
else:
    raise SystemExit("brotli is still installed")

# The server module must import without gradio (it is lazy in s_command.py),
# and the remaining multipart dependency must still expose Starlette's API.
from rembg.commands.s_command import s_command  # noqa: F401
from multipart.multipart import parse_options_header

parse_options_header('form-data; name="file"; filename="image.png"')
print("rembg deps patched: pillow", pillow_version)
PY

# Keep the base image's ENTRYPOINT ["rembg"] and CMD ["--help"].
