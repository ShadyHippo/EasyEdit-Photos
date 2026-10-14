# EasyEdit — the editor is plain static files (no build step), so the image is just nginx
# plus a copy of the site and the server block that proxies /bg/ to the rembg sidecar.
#
# Build:  docker build -t ghcr.io/shadyhippo/easyedit-photos:latest .
# Run:    docker compose up -d          (see docker-compose.yml)
FROM nginx:alpine

LABEL org.opencontainers.image.title="EasyEdit" \
      org.opencontainers.image.description="Self-hostable browser photo editor" \
      org.opencontainers.image.source="https://github.com/ShadyHippo/EasyEdit-Photos"

# Our server block: serves the site and proxies /bg/ -> http://rembg:7000 over the compose
# network (by service name, not a host port), so the two containers only need to share one.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# The editor itself.
COPY . /usr/share/nginx/html/
# nginx.conf is in the context only so it could be COPYed above; it is not a public asset.
RUN rm -f /usr/share/nginx/html/nginx.conf

EXPOSE 80

# "/" serves index.html, so a 200 here means nginx is up and the site is in place.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
