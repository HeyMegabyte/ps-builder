FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git ca-certificates gnupg \
    imagemagick ffmpeg jq unzip python3 \
    build-essential libvips-dev libcairo2-dev \
    libpango1.0-dev librsvg2-bin fonts-inter fontconfig \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Non-root user (Claude blocks --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash cuser && mkdir -p /app /tmp/builds && chown -R cuser:cuser /app /tmp/builds /home/cuser

COPY build-server.js /app/server.js
RUN chown cuser:cuser /app/server.js

EXPOSE 8080
CMD ["node", "/app/server.js"]
