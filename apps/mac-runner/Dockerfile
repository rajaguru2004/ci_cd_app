# syntax=docker/dockerfile:1.7
#
# The Release Console's Mac runner: the agent that connects a Mac to the console, takes its iOS
# runs, and runs their steps on the Mac over SSH (Xcode cannot run inside a Linux container).
# See README.md next to this file.
#
#   docker buildx build --platform linux/arm64,linux/amd64 \
#     --build-arg VERSION=1.0.0 -t rajaguru2004/release-console-mac-runner:1.0.0 --push apps/mac-runner
#
# One image for Apple silicon (arm64) and Intel (amd64) Macs, built without emulation: the
# TypeScript compiles once on the build machine, and the image itself is node:alpine plus files
# (no RUN after the first stage, so nothing has to execute for the other platform).

ARG NODE=24-alpine

FROM --platform=$BUILDPLATFORM node:${NODE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# No install scripts: ssh2's optional native speed-ups stay out; its JavaScript is used instead.
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --omit=optional --ignore-scripts \
 && mkdir -p /out/data

FROM node:${NODE}
ARG VERSION=dev
LABEL org.opencontainers.image.title="Release Console Mac runner" \
      org.opencontainers.image.description="Connects a Mac to the Release Console and builds and releases its iOS runs there (Xcode, Flutter, Fastlane on the Mac, over SSH)." \
      org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production \
    RUNNER_VERSION=${VERSION} \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The runner's own keys live here (a volume): its sealing key, its SSH key, the Mac's host key.
COPY --from=build --chown=node:node /out/data /data
USER node
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "dist/cli.js", "health"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["start"]
