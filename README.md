# EasyEdit-Photos

A self-hostable simple photo editor for the web.

## Container images

`scripts/publish.sh` publishes two packages from this one repository:

- `ghcr.io/<owner>/<repo>` — the static editor (nginx).
- `ghcr.io/<owner>/<repo>-rembg` — the patched rembg sidecar built from
  `rembg/Dockerfile` (rembg 2.0.86 with gradio removed, Pillow 13, no Brotli).

They are separate GHCR packages so the 1.6 GB model server can be updated
without republishing the editor. `compose.yaml` pulls both by default; use
`compose.dev.yaml` to build the sidecar locally.
