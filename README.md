# World Cup History MCP

> **by Zafronix** · npm: `@zafronix/wc-mcp` · MIT-licensed

Model Context Protocol server giving Claude / Cursor / any MCP-aware agent grounded access to every FIFA World Cup since 1930. **23 tournaments. 1,168+ matches. 2,500+ players. 206 stadiums.** All exposed as 15 typed tools so the model stops hallucinating squads, scores, brackets, and stadium altitudes.

Powered by the public [Zafronix World Cup API](https://api.zafronix.com/) — free tier with key, 1,000 req/day, no card.

## Why

LLMs are unreliable on:
- Exact tournament results from before the trained-data window.
- Roster details (jersey numbers, DOBs, captains).
- Knockout-round paths and exact scores.
- Stadium facts (capacity, altitude, year opened).

This MCP wraps the Zafronix WC API so the model can call a tool and get the canonical answer instead of guessing.

## Install

```bash
npm install -g @zafronix/wc-mcp
```

Or run from source:

```bash
git clone https://github.com/zafronix/wc-mcp
cd wc-mcp
npm install
npm run build
```

## Get a free API key

```
https://api.zafronix.com/signup
```

1,000 requests/day on the free tier, no card.

## Configure (Claude Desktop)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "wc": {
      "command": "npx",
      "args": ["-y", "@zafronix/wc-mcp"],
      "env": {
        "WC_API_KEY": "zwc_pk_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. You'll see a 🔌 icon in the input bar — click it to confirm `wc` is connected.

## Configure (Cursor)

Settings → MCP → Add new server:

```json
{
  "mcpServers": {
    "wc": {
      "command": "npx",
      "args": ["-y", "@zafronix/wc-mcp"],
      "env": { "WC_API_KEY": "zwc_pk_..." }
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `list_tournaments` | Every WC 1930→2026 (year, host, champion). |
| `get_tournament` | Full tournament: teams, brackets, awards, squads. |
| `compare_tournaments` | Side-by-side stats for 2-6 years. |
| `search_players` | Player name search across history. |
| `get_player_career` | Every WC a player appeared in. |
| `list_teams` | Every nation that ever played, optional confederation filter. |
| `get_team` | Cross-tournament summary for a country. |
| `get_team_roster` | Full squad for one team in one year. |
| `list_stadiums` | Every WC venue with elevation + coords. |
| `get_stadium` | Single venue by slug. |
| `list_matches` | Filter by year / stage / date. |
| `get_match` | Single match with score + attendance + referee. |
| `get_trivia` | Curated factual nuggets per year. |
| `get_standings` | Computed group tables with FIFA tiebreakers. |
| `get_bracket` | Full knockout bracket. |

## Example prompts (in Claude Desktop, with this MCP enabled)

- *"Compare Pelé and Messi at the World Cup."*
- *"What was the highest-altitude World Cup stadium ever, and how did goal totals there compare to sea-level venues?"*
- *"Show me Italy's 2006 squad with positions and clubs."*
- *"Trace Argentina's 2022 path to the title — every match, every score."*
- *"List every African nation that has reached the World Cup quarter-finals."*

## Development

```bash
npm run dev          # tsx watch mode
WC_API_KEY=... npm start
```

The server speaks stdio. You can test it with the MCP CLI:

```bash
npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

## License

MIT.
