# =============================================================================
# Dockerfile for the World Cup History MCP server.
#
# Used by:
#   - Glama (https://glama.ai) — verifies the server boots and responds
#     to MCP introspection (tools/list).
#   - Anyone who wants to run the server in an isolated environment
#     instead of installing the npm package globally.
#
# This Dockerfile installs the package directly from npm — no repo
# clone needed. Submit it to Glama by pasting the contents directly
# in their submission form (their note: 'add Dockerfile directly to
# Glama'); the public repo can stay private.
#
# Usage:
#   docker build -t wc-mcp -f Dockerfile .   # or paste into Glama
#   docker run --rm -i -e WC_API_KEY=zwc_pk_... wc-mcp
#
# For Claude Desktop / Cursor configuration, prefer `npx -y @zafronix/wc-mcp`
# directly — that's lighter than spinning up a container.
# =============================================================================

FROM node:20-alpine

LABEL org.opencontainers.image.title="World Cup History MCP"
LABEL org.opencontainers.image.description="MCP server wrapping the Zafronix World Cup API — every FIFA World Cup since 1930"
LABEL org.opencontainers.image.url="https://www.npmjs.com/package/@zafronix/wc-mcp"
LABEL org.opencontainers.image.source="https://www.npmjs.com/package/@zafronix/wc-mcp"
LABEL org.opencontainers.image.licenses="MIT"

# Install the published npm package globally. Pinning to ^0.1.2 to
# pick up patch fixes automatically; bump the major when we cut a
# breaking change. No local source required — Glama's verification
# environment has internet access to npm.
RUN npm install -g @zafronix/wc-mcp@^0.1.2 \
  && npm cache clean --force

# WC_API_KEY is intentionally NOT set here — the server boots without
# it (for introspection / tools/list) and tool calls return a clear
# auth error pointing the user to /signup. Provide your own key at
# runtime via `docker run -e WC_API_KEY=zwc_pk_...`.
ENV NODE_ENV=production

# Default command runs the MCP server on stdio. Glama's verification
# probe sends `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`
# on stdin and expects a valid MCP response on stdout.
ENTRYPOINT ["wc-mcp"]
