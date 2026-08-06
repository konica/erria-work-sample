# syntax=docker/dockerfile:1
#
# Custom Caddy build for the deployment overlay (issue #59). Stock `caddy:2.9-alpine` (what
# compose.deploy.yaml used before this ticket) has no rate-limiting handler — Caddy's core
# deliberately ships without one, so the Caddyfile's `rate_limit` directive on the Keycloak
# token endpoint needs github.com/mholt/caddy-ratelimit compiled in. xcaddy is how the Caddy
# project itself documents adding a plugin: a separate build stage, not a Caddyfile setting.
# Built once per deploy (deploy/README.md) — this replaces the previous `image: caddy:2.9-alpine`
# line in compose.deploy.yaml with `build:` against this file.

ARG CADDY_BUILDER_IMAGE=caddy:2.9-builder-alpine@sha256:0d51ab53402e144be9cab449f5adfec681b87d481dcd175230813427d5e00f00
ARG CADDY_RUNTIME_IMAGE=caddy:2.9-alpine@sha256:b4e3952384eb9524a887633ce65c752dd7c71314d2c2acf98cd5c715aaa534f0

FROM ${CADDY_BUILDER_IMAGE} AS build
RUN xcaddy build --with github.com/mholt/caddy-ratelimit

# Same base compose.deploy.yaml pinned before, so nothing else about the image (musl libc,
# installed CA certs, non-root capable entrypoint) changes — only the binary inside it does.
FROM ${CADDY_RUNTIME_IMAGE}
COPY --from=build /usr/bin/caddy /usr/bin/caddy
