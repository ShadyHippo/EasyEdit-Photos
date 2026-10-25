#!/usr/bin/env bash
# Build and push both EasyEdit images to GHCR.
#
#   scripts/publish.sh              build both, tag :latest + :<short-sha>, push
#   scripts/publish.sh v1.1.0       ... and also tag/push :v1.1.0
#   scripts/publish.sh --no-push    build only (e.g. on the server itself)
#
# Two packages come from this one repo:
#   ghcr.io/<owner>/<repo>          the static editor (nginx)
#   ghcr.io/<owner>/<repo>-rembg    the patched rembg sidecar (rembg/Dockerfile)
#
# They are deliberately separate packages: the 1.6 GB model server can be
# rebuilt and republished without touching the editor image. GitHub Packages
# allows any number of container packages per repository.
#
# ONE-TIME AUTH. The token must have write:packages, which gh's default token
# does NOT:
#   gh auth refresh -s write:packages
#   gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin
# ...or export GHCR_TOKEN=<a PAT with write:packages> and this script logs in
# for you. GH_TOKEN is used as a fallback when GHCR_TOKEN is unset, but it often
# lacks write:packages. If the token belongs to a different account than the
# repo owner, also set GHCR_USER.
#
# docker is used when present; otherwise buildah is used (no daemon needed).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

push=1
tag=""
for arg in "$@"; do
  case "$arg" in
    --no-push) push=0 ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) tag="$arg" ;;
  esac
done

remote=$(git config --get remote.origin.url 2>/dev/null || true)
case "$remote" in
  *github.com*) ;;
  *) echo "error: remote.origin.url is not a GitHub remote ($remote)" >&2; exit 1 ;;
esac
owner=$(printf '%s' "$remote" | sed -E 's#^.*github\.com[:/]##; s#/.*$##')
repo=$(printf '%s' "$remote" | sed -E 's#^.*github\.com[:/][^/]+/##; s#\.git$##; s#/$##')
# GHCR requires a lowercase path, but the GitHub owner/repo may not be.
owner_lc=$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]')
repo_lc=$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')
editor_image="ghcr.io/$owner_lc/$repo_lc"
rembg_image="$editor_image-rembg"

sha=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then
  echo "note: uncommitted changes present — $sha names the commit, not exactly this build." >&2
fi

editor_tags=("$editor_image:latest" "$editor_image:$sha")
rembg_tags=("$rembg_image:latest" "$rembg_image:$sha")
if [ -n "$tag" ]; then
  editor_tags+=("$editor_image:$tag")
  rembg_tags+=("$rembg_image:$tag")
fi

if command -v docker >/dev/null 2>&1; then
  builder=docker
elif command -v buildah >/dev/null 2>&1; then
  builder=buildah
else
  echo "error: need docker or buildah on PATH" >&2
  exit 1
fi

build_image() {
  local context=$1; shift
  local args=()
  for t in "$@"; do args+=(-t "$t"); done
  if [ "$builder" = docker ]; then
    docker build "${args[@]}" "$context"
  else
    # docker format keeps HEALTHCHECK, which OCI output drops.
    buildah bud --format docker "${args[@]}" "$context"
  fi
}

push_image() {
  local ref=$1
  if [ "$builder" = docker ]; then
    docker push "$ref"
  else
    local digest_file; digest_file=$(mktemp)
    buildah push --digestfile "$digest_file" "$ref" "docker://$ref"
    echo "digest $(cat "$digest_file")"
    rm -f "$digest_file"
  fi
}

echo "builder $builder"
echo "editor  $editor_image"
echo "rembg   $rembg_image"
echo "tags    latest $sha${tag:+ $tag}"
echo

echo "==> editor"
build_image . "${editor_tags[@]}"
echo
echo "==> rembg"
build_image rembg "${rembg_tags[@]}"

if [ "$push" = 0 ]; then
  echo
  echo "built only (--no-push)."
  exit 0
fi

# Credentials. GHCR_TOKEN is the documented input; GH_TOKEN is a convenience
# fallback for environments that already provide a packages-capable token.
token="${GHCR_TOKEN:-${GH_TOKEN:-}}"
login_user="${GHCR_USER:-$owner}"
if [ -n "$token" ]; then
  if [ "$builder" = docker ]; then
    printf '%s' "$token" | docker login ghcr.io -u "$login_user" --password-stdin >/dev/null
  else
    printf '%s' "$token" | buildah login --username "$login_user" --password-stdin ghcr.io >/dev/null
  fi
  echo "logged in as $login_user"
fi

push_all() {
  shift  # first argument is the image name; the tags are the rest
  for t in "$@"; do
    echo "==> push $t"
    local out
    if ! out=$(push_image "$t" 2>&1); then
      printf '%s\n' "$out" >&2
      if printf '%s' "$out" | grep -qi "permission_denied\|does not match expected scopes\|authentication required"; then
        cat >&2 <<'HINT'

The push was rejected: the credential lacks write:packages. Fix it once with:
  gh auth refresh -s write:packages
  gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin
...or export GHCR_TOKEN=<a PAT with write:packages>.
HINT
      fi
      exit 1
    fi
    printf '%s\n' "$out" | tail -1
  done
}

push_all "$editor_image" "${editor_tags[@]}"
push_all "$rembg_image" "${rembg_tags[@]}"

echo
echo "pushed:"
for ref in "${editor_tags[@]}" "${rembg_tags[@]}"; do echo "  $ref"; done
