#!/bin/bash
# Nexus Server – Pterodactyl install script (embedded in egg-nexus-server.json).
# Runs once in the install container (ghcr.io/pterodactyl/installers:alpine) with the
# server volume mounted at /mnt/server. Downloads the Linux build that every GitHub
# release of Nexus ships (nexus-server-linux-x64) and checks it against SHA256SUMS.txt.
set -euo pipefail
cd /mnt/server

REPO="Lioner2008/Nexus"
ASSET="nexus-server-linux-x64"
VERSION="${NEXUS_VERSION:-latest}"
VERSION="${VERSION// /}"
SUMS=""

if [ -n "${NEXUS_DOWNLOAD_URL:-}" ]; then
    URL="${NEXUS_DOWNLOAD_URL}"
elif [ -z "${VERSION}" ] || [ "${VERSION}" = "latest" ]; then
    URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
    SUMS="https://github.com/${REPO}/releases/latest/download/SHA256SUMS.txt"
else
    case "${VERSION}" in v*) ;; *) VERSION="v${VERSION}" ;; esac
    URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
    SUMS="https://github.com/${REPO}/releases/download/${VERSION}/SHA256SUMS.txt"
fi

echo "Downloading ${URL}"
if ! curl -fsSL --retry 3 -o nexus-server.download "${URL}"; then
    echo "ERROR: download failed. Does release '${VERSION}' have a '${ASSET}' asset?"
    echo "       Check https://github.com/${REPO}/releases (Linux builds exist from v0.5.2 on)"
    echo "       or set 'Download URL' to a direct link of a Linux x86_64 nexus-server binary."
    rm -f nexus-server.download
    exit 1
fi

if [ -n "${SUMS}" ] && curl -fsSL --retry 3 -o SHA256SUMS.txt "${SUMS}" 2>/dev/null; then
    expected="$(awk -v f="${ASSET}" '$2 == f { print $1 }' SHA256SUMS.txt)"
    if [ -n "${expected}" ]; then
        actual="$(sha256sum nexus-server.download | awk '{ print $1 }')"
        if [ "${expected}" != "${actual}" ]; then
            echo "ERROR: SHA-256 mismatch for ${ASSET} (expected ${expected}, got ${actual})"
            rm -f nexus-server.download SHA256SUMS.txt
            exit 1
        fi
        echo "SHA-256 verified"
    fi
    rm -f SHA256SUMS.txt
fi

mv -f nexus-server.download nexus-server
chmod +x nexus-server
mkdir -p nexus-data
echo "Installed: $(./nexus-server --version)"
echo "Set the variables on the Startup tab (invite code, TURN relay, public address), then start the server."
