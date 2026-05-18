# Playwright base — chromium is preinstalled at /ms-playwright matching
# the playwright npm version pinned in package.json. ~500 MB larger than
# node:20-alpine but the alternative (downloading chromium at runtime)
# pushes cold starts past 60 s. PLAYWRIGHT_BROWSERS_PATH is preset in
# this image so chromium.launch() finds chrome without an explicit path.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy
WORKDIR /app

# Skip browser download during npm install — image already ships them.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p .cache

EXPOSE 3000
CMD ["node", "server.js"]
