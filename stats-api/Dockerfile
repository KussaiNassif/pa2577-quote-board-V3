FROM node:20-alpine
WORKDIR /app
# package-lock.json pins every dependency version; `npm ci` installs exactly
# those, so the image is the same no matter what day it is built.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
RUN addgroup -S app && adduser -S app -G app
USER app
EXPOSE 3001
CMD ["node", "server.js"]
