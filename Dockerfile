FROM ghcr.io/puppeteer/puppeteer:22.12.1

# Install system FFmpeg under root user
USER root
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

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

# Command to boot Express server
CMD ["node", "server.js"]
