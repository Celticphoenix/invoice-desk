FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    INVOICE_DESK_HOST=0.0.0.0 \
    INVOICE_DESK_PORT=3210 \
    INVOICE_DESK_DATA_ROOT=/app/data

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const p=process.env.PORT||process.env.INVOICE_DESK_PORT||3210;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
