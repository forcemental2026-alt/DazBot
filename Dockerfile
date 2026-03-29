FROM node:18-alpine

# Use an unprivileged user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Create app directory
WORKDIR /app

# Install dependencies based on package.json
COPY package*.json ./
RUN npm install --production

# Bundle app source
COPY . .

# Change ownership of the app directory to the new user
RUN chown -R appuser:appgroup /app

USER appuser

# Run the bot
CMD ["npm", "start"]
