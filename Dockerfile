FROM node:18

WORKDIR /app

ARG CI_BUILD_VERSION
ENV API_VERSION=$CI_BUILD_VERSION

# Copy package files
COPY package*.json ./

# Install all dependencies
RUN npm ci

# Copy source code and TypeScript config
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript code
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --production

# Run the application
CMD ["node", "--experimental-specifier-resolution=node", "/app/dist/index.js"]