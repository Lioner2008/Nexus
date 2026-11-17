# nexus-server Docker image (Linux) – used by the Pterodactyl egg in pterodactyl/
# Built and pushed to GHCR by .github/workflows/docker.yml

# ── build stage ──────────────────────────────────────────────────────────────
FROM rust:1-bookworm AS builder
WORKDIR /build
COPY . .
RUN cargo build --release --locked

# ── runtime stage ────────────────────────────────────────────────────────────
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 container
COPY --from=builder /build/target/release/nexus-server /usr/local/bin/nexus-server
COPY nexus-entrypoint.sh /usr/local/bin/nexus-entrypoint.sh
RUN chmod +x /usr/local/bin/nexus-entrypoint.sh
# Pterodactyl mounts the server volume at /home/container and runs the startup
# command as the image user.
USER container
WORKDIR /home/container
EXPOSE 7777
CMD ["/usr/local/bin/nexus-server"]
