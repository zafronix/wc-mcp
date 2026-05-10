#!/usr/bin/env node
/**
 * Zafronix World Cup MCP Server
 *
 * Exposes the public Zafronix WC API as a set of MCP tools so Claude /
 * Cursor / any MCP-aware agent can answer "tell me about the 1986 final"
 * or "compare Pelé and Messi at the World Cup" with grounded, structured
 * data instead of hallucinating.
 *
 * Auth: requires a WC_API_KEY env var. Free key at api.zafronix.com/signup.
 *
 * Wire: stdio. Claude Desktop, Cursor MCP support, and the MCP CLI all
 * speak stdio. SSE transport can be added later if there's demand.
 *
 * Tool design philosophy:
 *   - Each tool maps cleanly to one or two REST endpoints.
 *   - Tool names are verb_subject (search_player, get_tournament).
 *   - Responses are JSON-stringified directly from the API. The LLM sees
 *     the same shape as a developer would, no over-summarization.
 *   - Schemas use zod for validation; descriptions tell the LLM exactly
 *     when to pick each tool.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────

const API_BASE = process.env.WC_API_BASE ?? 'https://api.zafronix.com/fifa/worldcup/v1';
const API_KEY  = process.env.WC_API_KEY;

// Boot-time tolerance for missing key: warn but proceed. The MCP
// protocol's tools/list and tools/get are introspection-only (no
// upstream API calls), so the server can advertise its tool catalog
// to clients like Claude Desktop / Glama / awesome-mcp validators
// without an API key. Actual tool invocations check for the key and
// return a structured error pointing the user to /signup.
//
// This matters for two reasons:
//   1. Glama (the MCP catalog used by awesome-mcp-servers for
//      verification) runs the server in a container with no API key
//      and probes tools/list. Boot-exit on missing key would fail
//      that check and block listing.
//   2. New users installing via Claude Desktop benefit from a clear
//      tool-call-time error ('You need to set WC_API_KEY in your
//      claude_desktop_config.json') rather than a silent process
//      exit they can't see.
if (!API_KEY) {
  console.error(
    '[wc-mcp] WC_API_KEY not set — server will boot for introspection,\n' +
    '       but tool calls will return an auth error until you set it.\n' +
    '       Get a free key: https://api.zafronix.com/signup\n' +
    '       Then add to your MCP client config:\n' +
    '         "env": { "WC_API_KEY": "zwc_pk_..." }',
  );
}

// Single fetch helper — adds auth header, parses JSON, surfaces useful
// errors back to the model instead of swallowing them. Throws an
// auth-required error when WC_API_KEY isn't set so the model surfaces
// a clear message to the user rather than a confusing 401 from the
// upstream API.
async function api<T = unknown>(path: string): Promise<T> {
  if (!API_KEY) {
    throw new Error(
      'WC_API_KEY is not set in the environment. Get a free key at ' +
      'https://api.zafronix.com/signup and add it to your MCP client ' +
      'config: { "env": { "WC_API_KEY": "zwc_pk_..." } }',
    );
  }
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'X-API-Key':  API_KEY,
      'Accept':     'application/json',
      'User-Agent': 'wc-mcp/0.1.2',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status} ${res.statusText} on ${path}: ${body.slice(0, 240)}`);
  }
  return res.json() as Promise<T>;
}

// Helper that returns MCP-shaped content. We always emit plain text with
// JSON inside; the model handles structured reasoning fine and this keeps
// the tool surface stable across MCP SDK minor versions.
function jsonContent(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorContent(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tool schemas (zod for validation, then converted to JSON Schema for MCP)
// ─────────────────────────────────────────────────────────────────────

const tools = [
  {
    name: 'list_tournaments',
    description:
      'List every FIFA World Cup tournament (1930 → 2026) with year, host country list, ' +
      'champion (or null for the upcoming 2026 cup). Useful as a starting point when the ' +
      'user is exploring history or needs to disambiguate a year.',
    schema: z.object({}).strict(),
    handler: async () => api('/tournaments'),
  },
  {
    name: 'get_tournament',
    description:
      'Get full details for a single World Cup tournament: every team that played, group ' +
      'stages, knockout brackets, awards (top scorer, best player, best young player, best ' +
      'GK), full squads with DOB/position/club, attendance, and trivia notes. Use this when ' +
      'the user asks about a specific year ("1986 World Cup", "what happened at Italia 90"). ' +
      'For comparisons across multiple tournaments use compare_tournaments instead.',
    schema: z.object({
      year: z.number().int().min(1930).max(2030).describe('Tournament year, e.g. 1986'),
    }).strict(),
    handler: async (args: { year: number }) => api(`/tournaments/${args.year}`),
  },
  {
    name: 'compare_tournaments',
    description:
      'Side-by-side comparison of 2-6 World Cup tournaments. Returns total goals, goals ' +
      'per match, attendance, top scorer, best player, champion, runner-up, third place ' +
      'for each year. Use this when the user asks "compare 1986 vs 2022" or "what changed ' +
      'between 1990 and 2014". For a single year use get_tournament.',
    schema: z.object({
      years: z.array(z.number().int().min(1930).max(2030)).min(1).max(6)
        .describe('Years to compare, e.g. [1986, 2002, 2022]'),
    }).strict(),
    handler: async (args: { years: number[] }) =>
      api(`/compare?years=${args.years.join(',')}`),
  },
  {
    name: 'search_players',
    description:
      'Search players by name. Returns every World Cup squad row matching the query, ' +
      'with team, position, DOB, club, and tournament-year goals. Use this when the user ' +
      'mentions a player by name. For a player\'s full multi-tournament career path use ' +
      'get_player_career.',
    schema: z.object({
      q: z.string().min(2).describe('Name fragment, e.g. "Maradona", "Mbappe", "Klose"'),
      limit: z.number().int().min(1).max(50).optional()
        .describe('Max results (default 20)'),
    }).strict(),
    handler: async (args: { q: string; limit?: number }) => {
      const params = new URLSearchParams({ q: args.q });
      if (args.limit) params.set('limit', String(args.limit));
      return api(`/players?${params.toString()}`);
    },
  },
  {
    name: 'get_player_career',
    description:
      'Get a player\'s full World Cup career: every tournament they appeared in, with ' +
      'team/position/jersey/goals/captain status per year. Use this when the user wants a ' +
      '"all of Pelé\'s World Cup matches" or "compare Messi\'s 4 World Cups" view. The ' +
      'name should be the canonical name (use search_players first if unsure).',
    schema: z.object({
      name: z.string().min(2).describe('Player name, e.g. "Diego Maradona", "Lionel Messi"'),
    }).strict(),
    handler: async (args: { name: string }) =>
      api(`/players/${encodeURIComponent(args.name)}`),
  },
  {
    name: 'list_teams',
    description:
      'List every national team that has ever played a World Cup, with confederation, ' +
      'first/last appearance year, and total appearances. Useful for "which African nations ' +
      'have made the World Cup?" or "list every CONMEBOL team". Pair with get_team for a ' +
      'specific country.',
    schema: z.object({
      confederation: z.enum(['UEFA', 'CONMEBOL', 'CONCACAF', 'AFC', 'CAF', 'OFC']).optional()
        .describe('Filter by confederation (optional)'),
    }).strict(),
    handler: async (args: { confederation?: string }) => {
      const params = new URLSearchParams();
      if (args.confederation) params.set('confederation', args.confederation);
      const path = `/teams${params.toString() ? `?${params.toString()}` : ''}`;
      return api(path);
    },
  },
  {
    name: 'get_team',
    description:
      'Cross-tournament summary for a national team: every appearance, final position by ' +
      'year, total titles, knockout records. Use this for "Brazil\'s World Cup history" ' +
      'or "how many times has Argentina reached the final?". For a specific year\'s squad ' +
      'use get_team_roster.',
    schema: z.object({
      name: z.string().min(2).describe('Country name, e.g. "Brazil", "West Germany", "England"'),
    }).strict(),
    handler: async (args: { name: string }) =>
      api(`/teams/${encodeURIComponent(args.name)}`),
  },
  {
    name: 'get_team_roster',
    description:
      'Full squad for one team in one tournament — every player with jersey, position, ' +
      'DOB, club, goals, captain flag. Use this for "who was on Spain\'s 2010 squad?" or ' +
      '"show me Italy\'s 2006 roster".',
    schema: z.object({
      name: z.string().min(2).describe('Team name, e.g. "Brazil"'),
      year: z.number().int().min(1930).max(2030).describe('Tournament year'),
    }).strict(),
    handler: async (args: { name: string; year: number }) =>
      api(`/teams/${encodeURIComponent(args.name)}/roster?year=${args.year}`),
  },
  {
    name: 'list_stadiums',
    description:
      'List World Cup venues. 206 stadiums total across history, with capacity, lat/long, ' +
      'elevation in meters, opening year, and the list of WC years each one hosted. Useful ' +
      'for "which stadiums hosted the most World Cup matches?" or "where was the 1986 final?". ' +
      'Filterable by country.',
    schema: z.object({
      country: z.string().optional().describe('Filter by country, e.g. "Mexico", "Brazil"'),
    }).strict(),
    handler: async (args: { country?: string }) => {
      const path = args.country ? `/stadiums?country=${encodeURIComponent(args.country)}` : '/stadiums';
      return api(path);
    },
  },
  {
    name: 'get_stadium',
    description:
      'Single venue details by stable slug ID. Slugs are kebab-case ("estadio-azteca", ' +
      '"maracana", "wembley-stadium-old", "metlife-stadium"). Use list_stadiums first if ' +
      'you need to discover the right ID.',
    schema: z.object({
      id: z.string().min(2).describe('Stadium slug, e.g. "estadio-azteca"'),
    }).strict(),
    handler: async (args: { id: string }) => api(`/stadiums/${args.id}`),
  },
  {
    name: 'list_matches',
    description:
      'List World Cup matches. Filterable by year and/or stage (group_a..group_h, ' +
      'round_of_16, quarter_final, semi_final, third_place, final). Returns kickoff time, ' +
      'home/away team, score, stadium, attendance. Use this for "show me all the 1990 ' +
      'group matches" or "list every World Cup final". Pair with get_match for a specific ' +
      'match\'s full details.',
    schema: z.object({
      year:  z.number().int().min(1930).max(2030).optional().describe('Tournament year (optional)'),
      stage: z.string().optional().describe('Stage filter, e.g. "final", "semi_final", "group_a"'),
      date:  z.string().optional().describe('YYYY-MM-DD — match-day filter (optional)'),
    }).strict(),
    handler: async (args: { year?: number; stage?: string; date?: string }) => {
      const params = new URLSearchParams();
      if (args.year)  params.set('year',  String(args.year));
      if (args.stage) params.set('stage', args.stage);
      if (args.date)  params.set('date',  args.date);
      const q = params.toString();
      return api(`/matches${q ? `?${q}` : ''}`);
    },
  },
  {
    name: 'get_match',
    description:
      'Single match by ID. IDs follow {year}-{ordinal} zero-padded — the 1986 final is ' +
      '"1986-052", the 2022 final is "2022-064", the 2026 opener is "2026-001". Returns ' +
      'kickoff, both teams, score, extra time, penalties, stadium, city, attendance, referee, ' +
      'and (with denormalize=true) the full stadium block.',
    schema: z.object({
      id: z.string().regex(/^\d{4}-\d{3}$/).describe('Match ID, e.g. "1986-052"'),
      denormalize: z.boolean().optional().describe('Embed full stadium details (default false)'),
    }).strict(),
    handler: async (args: { id: string; denormalize?: boolean }) => {
      const q = args.denormalize ? '?denormalize=true' : '';
      return api(`/matches/${args.id}${q}`);
    },
  },
  {
    name: 'get_trivia',
    description:
      'Curated factual nuggets about a tournament — record-setting moments, oddities, ' +
      'historical context. Each entry is a single fact with category. Use this when the ' +
      'user wants "interesting facts about 1958" or "tell me something I don\'t know about ' +
      'Italia 90". Far less hallucination-prone than free-recall about old tournaments.',
    schema: z.object({
      year: z.number().int().min(1930).max(2030).optional().describe('Tournament year (optional — omit for all)'),
    }).strict(),
    handler: async (args: { year?: number }) => {
      const path = args.year ? `/trivia?year=${args.year}` : '/trivia';
      return api(path);
    },
  },
  {
    name: 'get_standings',
    description:
      'Computed group standings with FIFA tiebreakers applied. Returns the order teams ' +
      'finished within each group of the given year, including W/D/L, GF, GA, GD, points. ' +
      'Use this for "show me the 1990 Group F table" or "who finished where in 2022 Group H?".',
    schema: z.object({
      year:  z.number().int().min(1930).max(2030).describe('Tournament year'),
      group: z.string().regex(/^[A-Z]$/).optional().describe('Single group letter (optional)'),
    }).strict(),
    handler: async (args: { year: number; group?: string }) => {
      const params = new URLSearchParams({ year: String(args.year) });
      if (args.group) params.set('group', args.group);
      return api(`/standings?${params.toString()}`);
    },
  },
  {
    name: 'get_bracket',
    description:
      'Full knockout bracket for a tournament — Round of 16 through Final, with each ' +
      'match\'s teams + result. Use this for "show me the 2014 World Cup bracket" or ' +
      '"trace France\'s 2018 path to the title".',
    schema: z.object({
      year: z.number().int().min(1930).max(2030).describe('Tournament year'),
    }).strict(),
    handler: async (args: { year: number }) => api(`/bracket?year=${args.year}`),
  },
] as const;

// ─────────────────────────────────────────────────────────────────────
// MCP server wiring
// ─────────────────────────────────────────────────────────────────────

const server = new Server(
  {
    name:    'wc-mcp',
    version: '0.1.0',
  },
  {
    capabilities: { tools: {} },
  },
);

// ListTools — convert our zod schemas into JSON Schema for the MCP wire.
// We use a tiny adapter rather than zod-to-json-schema to keep deps lean;
// every tool here uses a flat object with primitive props, so this is
// sufficient. If we add complex tools later, swap in the proper converter.
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (!(schema instanceof z.ZodObject)) {
    return { type: 'object', properties: {} };
  }
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, unknown> = {};
  const required:   string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    let f = field;
    let isOptional = false;
    if (f instanceof z.ZodOptional) {
      isOptional = true;
      f = f.unwrap();
    }
    const description = (f._def as { description?: string }).description;
    let prop: Record<string, unknown> = { description };

    if (f instanceof z.ZodString) {
      prop.type = 'string';
    } else if (f instanceof z.ZodNumber) {
      prop.type = 'integer';
    } else if (f instanceof z.ZodBoolean) {
      prop.type = 'boolean';
    } else if (f instanceof z.ZodEnum) {
      prop.type = 'string';
      prop.enum = (f._def as { values: string[] }).values;
    } else if (f instanceof z.ZodArray) {
      prop.type = 'array';
      const inner = (f._def as { type: z.ZodTypeAny }).type;
      if (inner instanceof z.ZodNumber)      prop.items = { type: 'integer' };
      else if (inner instanceof z.ZodString) prop.items = { type: 'string' };
      else                                    prop.items = {};
    } else {
      prop.type = 'string';
    }
    properties[key] = prop;
    if (!isOptional) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name:        t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = tools.find((t) => t.name === name);
  if (!tool) return errorContent(`unknown tool: ${name}`);
  try {
    const parsed = tool.schema.parse(args ?? {});
    // The handler signatures vary per tool; cast to any here is local +
    // narrow. Each handler is type-checked against its own schema.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool.handler as any)(parsed);
    return jsonContent(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorContent(`invalid arguments: ${err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`);
    }
    return errorContent(err instanceof Error ? err.message : String(err));
  }
});

// ─────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[wc-mcp] connected — 15 tools available');
}

main().catch((err) => {
  console.error('[wc-mcp] fatal:', err);
  process.exit(1);
});
