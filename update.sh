#!/usr/bin/env sh
# CargoClue updater — pulls the latest image and recreates the container.
#
# Usage:
#   ./update.sh
#
# Optional overrides (env vars):
#   CARGOCLUE_IMAGE   image to pull   (default: karimbizid/cargoclue:latest)
#   CARGOCLUE_PORT    host port       (default: 9999)
#   CARGOCLUE_NAME    container name  (default: cargoclue)
set -eu

IMAGE="${CARGOCLUE_IMAGE:-karimbizid/cargoclue:latest}"
PORT="${CARGOCLUE_PORT:-9999}"
NAME="${CARGOCLUE_NAME:-cargoclue}"

echo "→ Pulling ${IMAGE} ..."
docker pull "${IMAGE}"

echo "→ Replacing container '${NAME}' ..."
docker rm -f "${NAME}" >/dev/null 2>&1 || true

docker run -d --name "${NAME}" \
  --restart unless-stopped \
  -p "${PORT}:9999" \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  "${IMAGE}"

echo "✓ CargoClue updated and running on port ${PORT}."
