FROM node:24-alpine
# The release this image is built for (the workflow passes the tag); empty, server.mjs says its own.
ARG VERSION=
LABEL org.opencontainers.image.source="https://github.com/steggi-bernd/Songsta" \
      org.opencontainers.image.title="songsta-sync" \
      org.opencontainers.image.description="Songsta's sync service: playlists, playback and how the library is organised, the same on all your devices"
WORKDIR /app
COPY server.mjs .
ENV DATA_DIR=/data PORT=8196 SONGSTA_SYNC_VERSION=$VERSION
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8196
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8196/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server.mjs"]
