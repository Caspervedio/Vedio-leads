# Playwright base — chromium is preinstalled at /ms-playwright matching
# the playwright npm version pinned in package.json. ~500 MB larger than
# node:20-alpine but the alternative (downloading chromium at runtime)
# pushes cold starts past 60 s. PLAYWRIGHT_BROWSERS_PATH is preset in
# this image so chromium.launch() finds chrome without an explicit path.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy
WORKDIR /app

# Node.js is pinned to a patched release instead of the one the Playwright
# image shipped with: the 21 Oct 2026 security release (CVE-2026-111497, an
# out-of-bounds write in the Brotli decoder that can allow remote code
# execution - we fetch and decompress arbitrary shop websites - plus TLS
# hostname-check bypasses and seven more) is only in 24.22.1 and later.
# The official binary, checked against nodejs.org's SHA-256 list; it goes to
# /usr/local/bin, ahead of the image's own /usr/bin/node, and the build stops
# if any other version answers.
ARG NODE_VERSION=24.22.1
RUN set -eux; \
    case "$(dpkg --print-architecture)" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported architecture"; exit 1 ;; esac; \
    f="node-v${NODE_VERSION}-linux-${arch}.tar.gz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${f}"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " ${f}\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xzf "$f" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f "$f" SHASUMS256.txt; \
    test "$(node --version)" = "v${NODE_VERSION}"

# Skip browser download during npm install — image already ships them.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Exactly the lockfile, and no package install scripts: npm worms (Oct 2026)
# run their payload from a preinstall hook. None of our packages needs one.
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .
RUN mkdir -p .cache

EXPOSE 3000
CMD ["node", "server.js"]
