FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# System deps
RUN apt-get update && apt-get install -y \
    curl wget git ca-certificates gnupg sudo \
    imagemagick ffmpeg jq unzip zip \
    python3 python3-pip \
    build-essential pkg-config \
    libvips-dev librsvg2-bin fonts-inter fontconfig \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Non-root user with sudo
RUN useradd -m -s /bin/bash cuser \
    && echo "cuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \
    && mkdir -p /app /tmp/builds \
    && chown -R cuser:cuser /app /tmp/builds /home/cuser

COPY build-server.js /app/server.js
RUN chown cuser:cuser /app/server.js

EXPOSE 8080
