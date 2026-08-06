# Base image: official ESP-IDF v5.5 (same as .github/workflows/build.yml).
# Provides the ESP32 toolchain (idf.py) used to build examples/xiaozhi-esp32
# (the Exp-vocat firmware). IDF_PATH is preset to /opt/esp/idf by this image.
FROM espressif/idf:release-v5.5

ENV DEBIAN_FRONTEND=noninteractive

# Toolchain for qq-music-xiaozhi:
#   - Node.js 22 (QQ Music HTTP API + local MCP server + music proxy)
#   - python3-venv (Xiaozhi MCP pipe deps live in a project-local venv)
#   - ffmpeg (proxy transcodes MP3 -> 16k mono s16le PCM for the device)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git gnupg ffmpeg python3-venv \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Make idf.py available in login shells (Cloud Agent terminals run login shells)
# so `idf.py build` works without manually sourcing export.sh. Kept quiet and
# non-fatal so it never breaks a shell if the IDF env is unavailable.
RUN printf '%s\n' '[ -n "$IDF_PATH" ] && . "$IDF_PATH/export.sh" >/dev/null 2>&1 || true' \
        > /etc/profile.d/esp-idf.sh
