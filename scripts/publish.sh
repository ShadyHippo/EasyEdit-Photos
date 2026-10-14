#!/usr/bin/env bash
# Build the editor image and push it to GHCR — from this machine. No CI involved.
#
#   scripts/publish.sh              build, tag :latest + :<short-sha>, push
#   scripts/publish.sh v1.1.0       ... and also tag/push :v1.1.0
#   scripts/publish.sh --no-push    build only (e.g. building on the server itself)
#
# The image name is derived from the git remote, so a fork publishes to its own owner.
#
# ONE-TIME AUTH. The token must have write:packages, which gh's default token does NOT:
#   gh auth refresh -s write:packages
#   gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin
# ...or export GHCR_TOKEN=<a PAT with write:packages> and this script logs in for you.
# If that token belongs to a different account than the repo owner, also set GHCR_USER.
#
# Afterwards `docker login` is remembered, so plain `scripts/publish.sh` is enough.
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
image="ghcr.io/$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]')/$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')"

sha=$(git rev-parse --short HEAD)
tags=("latest" "$sha")
[ -n "$tag" ] && tags+=("$tag")

# The build uses the working tree, but $sha names a commit. Say so if they differ, otherwise
# a :<sha> tag can point at something that was never committed.
if [ -n "$(git status --porcelain)" ]; then
  echo "note: uncommitted changes present — $sha names the commit, not exactly this build." >&2
fi

build_args=(); for t in "${tags[@]}"; do build_args+=(-t "$image:$t"); done

echo "image  $image"
echo "tags   ${tags[*]}"
echo

if [ -n "${GHCR_TOKEN:-}" ]; then
  # The username must match the token's owner, which is normally the repo owner; GHCR_USER
  # overrides it for the case where the token belongs to a different account.
  login_user="${GHCR_USER:-$owner}"
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$login_user" --password-stdin >/dev/null
  echo "logged in as $login_user (GHCR_TOKEN)"
fi

docker build "${build_args[@]}" .

[ "$push" = 1 ] || { echo; echo "built only (--no-push)."; exit 0; }

echo
for t in "${tags[@]}"; do
  if ! err=$(docker push "$image:$t" 2>&1); then
    printf '%s\n' "$err" >&2
    if printf '%s' "$err" | grep -qi "permission_denied\|does not match expected scopes"; then
      cat >&2 <<'HINT'

The push was rejected: the credential lacks write:packages. Fix it once with:
  gh auth refresh -s write:packages
  gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin
...or export GHCR_TOKEN=<a PAT with write:packages>.
HINT
    fi
    exit 1
  fi
  printf '%s\n' "$(printf '%s' "$err" | tail -1)"
done

echo
echo "pushed. digest:"
docker inspect --format '{{index .RepoDigests 0}}' "$image:latest" 2>/dev/null || true
