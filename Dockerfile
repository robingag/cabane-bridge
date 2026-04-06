FROM node:20-alpine

# Timezone support
RUN apk add --no-cache tzdata
ENV TZ=America/Montreal

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY index.js ./

# Non-root user pour la sécurité
RUN addgroup -S bridge && adduser -S bridge -G bridge
USER bridge

CMD ["node", "index.js"]
