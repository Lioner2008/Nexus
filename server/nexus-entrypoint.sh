#!/bin/sh
# nexus-server entrypoint for Pterodactyl: builds the argument list from the
# environment variables set by Wings (SERVER_PORT) and the egg variables.
set -eu

PORT="${SERVER_PORT:-7777}"
ARGS="--bind 0.0.0.0:${PORT} --data nexus-data"

if [ "${TURN_ENABLED:-1}" = "1" ]; then
    ARGS="${ARGS} --turn --turn-port ${TURN_PORT:-3478} --relay-min ${RELAY_MIN:-49160} --relay-max ${RELAY_MAX:-49200}"
fi
if [ -n "${INVITE_CODE:-}" ]; then
    ARGS="${ARGS} --invite ${INVITE_CODE}"
fi
if [ -n "${PUBLIC_IP:-}" ]; then
    ARGS="${ARGS} --public-ip ${PUBLIC_IP}"
fi

echo "nexus-server ${ARGS}"
exec /usr/local/bin/nexus-server ${ARGS}
