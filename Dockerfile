FROM ubuntu:latest

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/cuser

# Core system deps + top 30 tools for web building
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

# Node.js (latest LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user with sudo (Claude Code blocks --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash cuser \
    && echo "cuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \
    && mkdir -p /app /tmp/builds \
    && chown -R cuser:cuser /app /tmp/builds /home/cuser

# Switch to cuser for all remaining installs
USER cuser
WORKDIR /home/cuser

# Homebrew (lets Claude Code install anything it needs)
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    && echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> /home/cuser/.bashrc \
    && echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> /home/cuser/.profile

ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

# Claude Code CLI (installed as cuser so it works with --dangerously-skip-permissions)
RUN npm install -g @anthropic-ai/claude-code

# Copy build server
USER root
COPY build-server.js /app/server.js
RUN chown cuser:cuser /app/server.js

EXPOSE 8080

# Run as root — the server itself switches to cuser for Claude Code execution
CMD ["node", "/app/server.js"]
