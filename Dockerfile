FROM ubuntu:latest

ENV DEBIAN_FRONTEND=noninteractive

# Core system deps
RUN apt-get update && apt-get install -y \
    curl wget git ca-certificates gnupg sudo \
    imagemagick ffmpeg jq unzip zip \
    python3 python3-pip python3-venv \
    build-essential pkg-config \
    libvips-dev libcairo2-dev libpango1.0-dev librsvg2-bin \
    fonts-inter fontconfig \
    chromium-browser \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (install as root — global npm needs root)
RUN npm install -g @anthropic-ai/claude-code

# Non-root user with sudo (Claude blocks --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash cuser \
    && echo "cuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \
    && mkdir -p /app /tmp/builds \
    && chown -R cuser:cuser /app /tmp/builds /home/cuser

# Homebrew (installed as cuser — lets Claude Code install anything it needs at runtime)
USER cuser
ENV HOME=/home/cuser
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

# Copy build server (as root for file ownership)
USER root
COPY build-server.js /app/server.js
RUN chown cuser:cuser /app/server.js

EXPOSE 8080
CMD ["node", "/app/server.js"]
