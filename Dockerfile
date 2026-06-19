FROM ghcr.io/puppeteer/puppeteer:22.12.1

# Install system FFmpeg under root user
USER root

# Remove Google Chrome apt lists to prevent GPG signature verification errors.
# We do not need to update Chrome as it is already pre-installed in the base container.
RUN rm -f /etc/apt/sources.list.d/google*.list \
    && apt-get update \
    && apt-get install -y ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set working directory inside container
WORKDIR /app

# Copy package configurations and clean-install npm dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Expose default express server port
ENV PORT=3000
EXPOSE 3000

# Command to boot Express server with exposed garbage collection
CMD ["node", "--expose-gc", "server.js"]
