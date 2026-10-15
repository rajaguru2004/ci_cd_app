# syntax=docker/dockerfile:1.7
#
# The builder: git over SSH, the vault of keys, and the release pipeline for every app the
# console manages. Build context is the repository root (it needs mobile-pipeline/ for the
# Fastlane lanes):
#   docker compose build builder
#
# Toolchain: Flutter 3.47.5, JDK 17, Android SDK 36, Ruby + Fastlane. The first stages are the
# heavy, rarely changing toolchain; what changes with the console comes last.

FROM eclipse-temurin:17-jdk-noble AS toolchain
ARG FLUTTER_VERSION=3.47.5
ARG ANDROID_CMDLINE_TOOLS=16111833
ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    FLUTTER_ROOT=/opt/flutter \
    PUB_CACHE=/cache/pub \
    GRADLE_USER_HOME=/cache/gradle \
    PATH=/opt/flutter/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:${PATH}
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates git unzip xz-utils zip procps ruby-full build-essential libyaml-dev \
 && rm -rf /var/lib/apt/lists/*
# Uploaded code runs as this unprivileged user; it cannot read the Play key.
RUN useradd --create-home --uid 1001 --shell /bin/bash builder
RUN mkdir -p /opt/android-sdk/cmdline-tools /cache/pub /cache/gradle \
 && curl -fsSL -o /tmp/clt.zip "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip" \
 && unzip -q /tmp/clt.zip -d /opt/android-sdk/cmdline-tools \
 && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
 && rm /tmp/clt.zip \
 && (yes | sdkmanager --licenses > /dev/null) \
 && sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0" > /dev/null
RUN curl -fsSL "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz" \
    | tar -xJ -C /opt \
 && chown -R builder:builder /opt/flutter /opt/android-sdk /cache
USER builder
RUN git config --global --add safe.directory /opt/flutter \
 && flutter config --no-analytics \
 && flutter precache --android \
 && flutter --version
USER root

FROM toolchain AS fastlane
# The same Gemfile.lock the GitHub pipeline installs; the gems go to the system gem path so
# a per-run copy of the Gemfile resolves against them.
COPY mobile-pipeline/Gemfile mobile-pipeline/Gemfile.lock /opt/pipeline/
RUN gem install bundler --no-document \
 && cd /opt/pipeline \
 && bundle install --jobs 4 \
 && bundle exec fastlane --version | tail -n 1

FROM node:20-bookworm-slim AS runner-build
WORKDIR /app
COPY apps/builder/package.json apps/builder/package-lock.json ./
RUN npm ci --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=20000
COPY apps/builder/tsconfig.json apps/builder/tsconfig.build.json ./
COPY apps/builder/src ./src
RUN npm run build && npm prune --omit=dev

FROM fastlane AS builder
ARG FLUTTER_VERSION=3.47.5
# ssh for git over SSH (the toolchain layers above stay cached when this one changes).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node:20-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY mobile-pipeline/fastlane /opt/pipeline/fastlane
# What a Mac downloads to set its runner up (served at /api/runner/v1/files/…).
COPY apps/mac-runner/docker-compose.yml apps/mac-runner/setup-mac.sh apps/mac-runner/.env.example /opt/mac-runner/
COPY --from=runner-build /app /opt/runner
ENV NODE_ENV=production \
    PORT=4000 \
    TOOLCHAIN_FLUTTER=${FLUTTER_VERSION}
EXPOSE 4000
# The runner is root: it alone reads the vault (SSH keys, keystores, Play keys) and runs git,
# signing and Fastlane; every build step is handed to the unprivileged `builder` user, which
# can read none of them (see src/pipeline.ts).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/opt/runner/dist/main.js"]
