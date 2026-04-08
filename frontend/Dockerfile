FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
# Vite inlines env vars prefixed with VITE_ at build time. They must be
# present in the BUILDER shell when `npm run build` runs — pass them as
# ARGs from docker compose and re-export as ENV so Vite picks them up.
ARG VITE_API_BASE=""
ARG VITE_POSTHOG_KEY=""
ARG VITE_POSTHOG_HOST=""
ARG VITE_BASE="/"
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_POSTHOG_KEY=$VITE_POSTHOG_KEY \
    VITE_POSTHOG_HOST=$VITE_POSTHOG_HOST \
    VITE_BASE=$VITE_BASE
RUN npm run build

FROM nginx:alpine
ARG NGINX_CONF=nginx.conf
COPY --from=builder /app/dist /usr/share/nginx/html
COPY ${NGINX_CONF} /etc/nginx/conf.d/default.conf
EXPOSE 8080
# nginx master must start as root to bind port 8080, but worker processes
# run as the 'nginx' user (configured in the default nginx.conf).
