const express = require('express');
const axios = require('axios');
const { randomUUID } = require('crypto');
const { logger } = require('@librechat/data-schemas');
const {
  saveMessage,
  saveConvo,
  getMessages,
  getAllUserMemories,
  setMemory,
  getUserById,
} = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');
const { parseGate, isServerAllowedForUser } = require('~/server/utils/mcpUserGate');

/**
 * Realtime voice (WebRTC) routes.
 *
 * Architecture (see .github/skills/librechat-voice): the browser opens a WebRTC
 * peer connection DIRECTLY to Azure OpenAI's realtime endpoint for low-latency
 * speech-to-speech. This server's only jobs are:
 *   1. POST /api/realtime/session  — mint a short-lived (≈60s) EPHEMERAL client
 *      secret per authenticated user. The standing Azure API key NEVER leaves
 *      the server; only the ephemeral token (single realtime-call scope) is
 *      returned to the browser. This is the Azure/OpenAI-documented pattern.
 *   2. POST /api/realtime/transcript — persist a completed voice turn (the user
 *      utterance + the assistant reply transcript) into the user's conversation
 *      so voice turns appear in the thread exactly like typed messages and
 *      survive reload. Strictly scoped to req.user.id (a user only ever writes
 *      to their own threads).
 *   3. GET  /api/realtime/config — feature-flag probe so the client can hide the
 *      voice button when realtime isn't configured. Kept separate from
 *      /api/config to avoid touching that route's strict (zod) schema.
 *
 * All routes require JWT auth (per-user identity, no shared token).
 */

const router = express.Router();
router.use(requireJwtAuth);

const AZURE_REALTIME_ENDPOINT = (process.env.AZURE_REALTIME_ENDPOINT || '').replace(/\/+$/, '');
const AZURE_REALTIME_API_KEY = process.env.AZURE_REALTIME_API_KEY || '';
const AZURE_REALTIME_DEPLOYMENT = process.env.AZURE_REALTIME_DEPLOYMENT || 'gpt-realtime-1-5';
const REALTIME_VOICE = process.env.AZURE_REALTIME_VOICE || 'marin';
const REALTIME_INSTRUCTIONS =
  process.env.AZURE_REALTIME_INSTRUCTIONS ||
  'You are a helpful, concise voice assistant. Speak naturally and keep responses brief.';

const isEnabled = () => Boolean(AZURE_REALTIME_ENDPOINT && AZURE_REALTIME_API_KEY);

// A voice conversation must be CONTINUABLE BY TEXT. The realtime answer comes
// from Azure's speech model, NOT from a routable text-chat endpoint, and the UI
// endpoint the user happened to be on may be unusable for a typed follow-up
// (e.g. `agents` with no agent selected → "Something went wrong"). So we
// attribute persisted voice turns to a KNOWN-GOOD chat endpoint+model that
// LibreChat can route. Defaults match this deployment's custom LiteLLM endpoint.
const REALTIME_CHAT_ENDPOINT = process.env.REALTIME_CHAT_ENDPOINT || 'Homelab';
const REALTIME_CHAT_MODEL = process.env.REALTIME_CHAT_MODEL || 'claude-sonnet-4.6';

// --- Read-only-by-default MCP tool bridge for voice (mirrors voice-gateway) ---
// The realtime model runs in Azure's cloud and can't reach in-cluster MCP
// servers; the browser can't either (NetworkPolicy + CORS). So the model emits
// a function call over the data channel, the browser relays {name,args} to
// POST /api/realtime/tool, and THIS server executes it in-cluster and returns
// the result. SAFETY: only operationIds in REALTIME_TOOL_ALLOW are advertised,
// AND a hard mutating-verb deny net blocks any write tool UNLESS it is
// explicitly opted into REALTIME_MUTATING_ALLOW. A mutating tool additionally
// requires an MCP_USER_GATE entry, an authorized user, and a server-side action
// credential. Conversational confirmation is UX, not an authorization boundary.
//   REALTIME_MCP_SERVERS:    comma-separated `name=url[,name=url]`
//   REALTIME_TOOL_ALLOW:     comma-separated allowed operationIds
//   REALTIME_MUTATING_ALLOW: comma-separated write tools allowed as exceptions
//   REALTIME_MCP_ACTION_TOKEN_ENVS: comma-separated `name=ENV_VAR` mappings
function parseUniqueAssignments(raw, parseValue) {
  const assignments = new Map();
  const ambiguous = new Set();
  const seen = new Set();
  for (const entry of (raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    const idx = entry.indexOf('=');
    if (idx < 0) {
      continue;
    }
    const key = entry.slice(0, idx).trim();
    if (!key) {
      continue;
    }
    if (seen.has(key)) {
      assignments.delete(key);
      ambiguous.add(key);
      continue;
    }
    seen.add(key);
    const value = parseValue(entry.slice(idx + 1).trim());
    if (value == null) {
      ambiguous.add(key);
      continue;
    }
    assignments.set(key, value);
  }
  return assignments;
}

function parseMcpServers(raw) {
  return [...parseUniqueAssignments(raw, (value) => value.replace(/\/+$/, '') || null)].map(
    ([name, url]) => ({ name, url }),
  );
}

function parseActionTokenEnvs(raw) {
  const assignments = parseUniqueAssignments(raw, (value) =>
    /^[A-Z_][A-Z0-9_]*$/.test(value) ? value : null,
  );
  const owners = new Map();
  const sharedEnvNames = new Set();
  for (const [serverName, envName] of assignments) {
    if (owners.has(envName)) {
      sharedEnvNames.add(envName);
    } else {
      owners.set(envName, serverName);
    }
  }
  for (const envName of sharedEnvNames) {
    assignments.delete(owners.get(envName));
    for (const [serverName, candidate] of assignments) {
      if (candidate === envName) {
        assignments.delete(serverName);
      }
    }
  }
  return assignments;
}

const MCP_SERVERS = parseMcpServers(process.env.REALTIME_MCP_SERVERS || '');
const TOOL_ALLOW = new Set(
  (process.env.REALTIME_TOOL_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean),
);
const MUTATING_ALLOW = new Set(
  (process.env.REALTIME_MUTATING_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean),
);
const ACTION_TOKEN_ENVS = parseActionTokenEnvs(process.env.REALTIME_MCP_ACTION_TOKEN_ENVS || '');
// Defense-in-depth: never expose a tool whose name contains any of these,
// regardless of the allow-list, unless it is in MUTATING_ALLOW.
const DENY_SUBSTR = [
  'delete', 'remove', '_add', 'restart', 'reboot', 'pause', 'resume', 'block',
  'unblock', 'reconnect', '_scan', 'trigger', 'run_shortcut', 'search_missing',
  'wlan_set', 'cf_dns', 'set_', '_set', 'purge', 'prune', 'cleanup', '_stop',
  '_start', 'launch', 'upgrade', 'apply', 'create', 'update', 'write', 'kill', 'drain',
];
const TOOL_MAX = parseInt(process.env.REALTIME_TOOL_MAX || '28', 10);
const TOOL_CALL_CHARS = parseInt(process.env.REALTIME_TOOL_CALL_CHARS || '3000', 10);

// --- Per-user memory over voice (works with WebRTC via the tool relay) -------
// Memory has two halves, both scoped to req.user.id so a user only ever sees
// their own (reusing LibreChat's NATIVE memory store, so voice + text memory
// are unified):
//   RECALL  — at /session we load the user's memories and prepend them to the
//             realtime instructions, so the assistant already "knows" them.
//   SAVE    — a `memory_save` tool the model calls when the user shares a
//             durable fact ("remember that ..."); relayed through /tool and
//             written with setMemory(). Enabled by REALTIME_MEMORY=true.
const MEMORY_ENABLED = (process.env.REALTIME_MEMORY || 'false').toLowerCase() === 'true';
const MEMORY_MAX_CHARS = parseInt(process.env.REALTIME_MEMORY_MAX_CHARS || '2000', 10);

const MEMORY_TOOL = {
  type: 'function',
  name: 'memory_save',
  description:
    'Save a durable personal fact about the user for future conversations '
    + '(e.g. preferences, family details, recurring needs). Use ONLY when the '
    + 'user shares something worth remembering long-term, or says "remember…". '
    + 'Do not save secrets, one-off requests, or sensitive medical data.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      key: {
        type: 'string',
        description: 'Short topic slug for this memory, e.g. "preferred_doctor" or "kids".',
      },
      value: { type: 'string', description: 'The fact to remember, one or two sentences.' },
    },
    required: ['value'],
  },
};

async function loadMemoryText(userId) {
  if (!MEMORY_ENABLED || !userId) {
    return '';
  }
  try {
    const memories = await getAllUserMemories(userId);
    if (!memories || !memories.length) {
      return '';
    }
    const lines = memories
      .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
      .map((m) => `- ${m.key ? m.key + ': ' : ''}${m.value}`);
    let text = lines.join('\n');
    if (text.length > MEMORY_MAX_CHARS) {
      text = text.slice(0, MEMORY_MAX_CHARS);
    }
    return text;
  } catch (err) {
    logger.warn(`[realtime] memory load failed: ${err.message}`);
    return '';
  }
}

// Continue the OPEN text conversation over voice: load its recent turns so the
// voice model shares the SAME context as the chat thread (env-tunable budget so
// a long thread can't blow the realtime prompt). User-scoped: getMessages filters
// by user id, so a session can only ever load the caller's own conversation.
const HISTORY_MAX_MESSAGES = parseInt(process.env.REALTIME_HISTORY_MAX_MESSAGES || '40', 10);
const HISTORY_MAX_CHARS = parseInt(process.env.REALTIME_HISTORY_MAX_CHARS || '8000', 10);

async function loadConversationText(userId, conversationId) {
  if (!userId || !conversationId) {
    return '';
  }
  try {
    const messages = await getMessages({ conversationId, user: userId });
    if (!messages || !messages.length) {
      return '';
    }
    const turns = messages
      .filter((m) => m && typeof m.text === 'string' && m.text.trim())
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
      .slice(-HISTORY_MAX_MESSAGES)
      .map((m) => `${m.isCreatedByUser ? 'User' : 'Assistant'}: ${m.text.trim()}`);
    let text = turns.join('\n');
    if (text.length > HISTORY_MAX_CHARS) {
      text = text.slice(-HISTORY_MAX_CHARS); // keep the MOST RECENT context
    }
    return text;
  } catch (err) {
    logger.warn(`[realtime] conversation history load failed: ${err.message}`);
    return '';
  }
}

async function saveMemory(userId, key, value) {
  // Hard per-user guard: never write memory without an authenticated user id
  // (requireJwtAuth guarantees one upstream; this is defense-in-depth so a
  // memory can never land in an unscoped/shared bucket).
  if (!userId) {
    return 'Could not save that (no authenticated user).';
  }
  const v = (value || '').trim();
  if (!v) {
    return 'Nothing to remember.';
  }
  const k = (key || '').trim() || `note_${Date.now()}`;
  try {
    // setMemory upserts by (userId, key). Rough token estimate keeps the usage
    // meter sane without pulling the tokenizer onto this path.
    await setMemory({ userId, key: k, value: v, tokenCount: Math.ceil(v.length / 4) });
    return `Saved to memory: ${v}`;
  } catch (err) {
    logger.warn(`[realtime] memory save failed: ${err.message}`);
    return 'Could not save that to memory right now.';
  }
}

// --- Web search over voice (FREE, in-cluster SearXNG) ------------------------
// Voice users asked "what's the score / latest news" and got "I have no
// internet" because the realtime model has NO tools by default. This gives it a
// read-only web_search tool backed by the in-cluster SearXNG (no API key,
// reachable via the allow-librechat-to-searxng NetworkPolicy). Enabled by
// REALTIME_WEB_SEARCH=true; the SearXNG URL reuses SEARXNG_INSTANCE_URL (already
// set on the deployment for LibreChat's native text web search). The schema is
// hand-written clean (additionalProperties:false, no anyOf) so Azure realtime
// accepts it (see the rt8 sanitize lesson).
const WEB_SEARCH_ENABLED = (process.env.REALTIME_WEB_SEARCH || 'false').toLowerCase() === 'true';
const WEB_SEARCH_URL = (process.env.SEARXNG_INSTANCE_URL || '').replace(/\/+$/, '');
const WEB_SEARCH_MAX_RESULTS = parseInt(process.env.REALTIME_WEB_SEARCH_RESULTS || '6', 10);

const WEB_SEARCH_TOOL = {
  type: 'function',
  name: 'web_search',
  description:
    'Search the public web for current, real-world information (news, sports '
    + 'scores, events, prices, recent facts). Returns the top result titles, '
    + 'URLs and snippets. Use this whenever the user asks about something recent, '
    + 'time-sensitive, or that you are not certain about.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        description: 'The search query, e.g. "FIFA World Cup 2026 results".',
      },
    },
    required: ['query'],
  },
};

async function searchWeb(query) {
  const q = (query || '').trim();
  if (!q) {
    return 'No search query provided.';
  }
  if (!WEB_SEARCH_URL) {
    return 'Web search is not configured.';
  }
  try {
    const r = await axios.get(`${WEB_SEARCH_URL}/search`, {
      params: { q, format: 'json', safesearch: 1 },
      timeout: 15000,
    });
    const results = Array.isArray(r.data?.results) ? r.data.results : [];
    if (!results.length) {
      return `No web results for "${q}".`;
    }
    const lines = results.slice(0, WEB_SEARCH_MAX_RESULTS).map((x, i) => {
      const title = (x.title || '').trim();
      const url = (x.url || '').trim();
      const snippet = (x.content || '').trim().replace(/\s+/g, ' ').slice(0, 300);
      return `${i + 1}. ${title}\n   ${url}\n   ${snippet}`;
    });
    return `Top web results for "${q}":\n` + lines.join('\n');
  } catch (err) {
    logger.warn(`[realtime] web_search failed: ${err.message}`);
    return 'Web search is unavailable right now.';
  }
}

let toolDefs = [];
let toolDispatch = {}; // name -> { url, path }
let toolsLoaded = false;
let toolsLoadAttempt = 0;

async function resolveUserEmail(user) {
  const direct = String(user?.email || '').trim();
  if (direct) {
    return direct;
  }
  const userId = user?.id || user?._id;
  if (!userId) {
    return '';
  }
  try {
    const resolved = await getUserById(userId, 'email');
    return String(resolved?.email || '').trim();
  } catch {
    logger.warn('[realtime] user identity lookup failed');
    return '';
  }
}

function mutationHeaders(target) {
  if (!target.mutating) {
    return {};
  }
  if (!parseGate().has(target.serverName)) {
    return null;
  }
  const envName = ACTION_TOKEN_ENVS.get(target.serverName);
  const actionToken = envName ? String(process.env[envName] || '').trim() : '';
  if (!actionToken) {
    return null;
  }
  return { 'X-Tessera-Action-Token': actionToken };
}

async function toolsForUser(user) {
  const email = await resolveUserEmail(user);
  return toolDefs.filter((definition) => {
    const target = toolDispatch[definition.name];
    if (!target || !isServerAllowedForUser(target.serverName, email)) {
      return false;
    }
    return mutationHeaders(target) !== null;
  });
}

// Azure's realtime function-tool validator is STRICT: it 500s on `anyOf` and on
// `additionalProperties: true` in a tool's parameter schema (verified live).
// FastAPI/Pydantic emit exactly those for optional/open bodies (e.g. RM wraps
// every tool body in `anyOf:[{additionalProperties:true,type:object},{null}]`),
// so advertising any such tool made /session 502. This coerces a tool's
// parameter schema into the clean object schema Azure accepts: collapse anyOf to
// its first object branch, keep real `properties`, recurse into nested
// properties/items, and force additionalProperties:false everywhere.
function sanitizeToolSchema(node) {
  if (Array.isArray(node)) {
    return node.map(sanitizeToolSchema);
  }
  if (!node || typeof node !== 'object') {
    return node;
  }
  let n = { ...node };
  // Collapse anyOf/oneOf/allOf: prefer the first object branch, else first non-null.
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(n[key])) {
      const branches = n[key];
      const obj = branches.find((b) => b && b.type === 'object') ||
        branches.find((b) => b && b.type && b.type !== 'null') ||
        branches[0] || {};
      delete n[key];
      n = { ...obj, ...n }; // merge branch fields (e.g. properties) under n
    }
  }
  if (n.type === 'object' || n.properties) {
    n.type = 'object';
    const props = {};
    for (const [k, v] of Object.entries(n.properties || {})) {
      props[k] = sanitizeToolSchema(v);
    }
    n.properties = props;
    // Azure requires additionalProperties:false (true / object form -> 500).
    n.additionalProperties = false;
  }
  if (n.items) {
    n.items = sanitizeToolSchema(n.items);
  }
  delete n.title;
  return n;
}

function coerceText(d) {
  if (typeof d === 'string') {
    return d;
  }
  if (Array.isArray(d)) {
    return d.map(coerceText).filter(Boolean).join('\n');
  }
  if (d && typeof d === 'object') {
    for (const k of ['response', 'content', 'result', 'text', 'markdown', 'data']) {
      const v = d[k];
      if (typeof v === 'string' && v) {
        return v;
      }
      if (v && (Array.isArray(v) || typeof v === 'object')) {
        const t = coerceText(v);
        if (t) {
          return t;
        }
      }
    }
    try {
      return JSON.stringify(d);
    } catch {
      return String(d);
    }
  }
  return '';
}

async function loadOneServer(serverName, url) {
  const r = await axios.get(`${url}/openapi.json`, { timeout: 10000 });
  const spec = r.data || {};
  const defs = [];
  const dispatch = {};
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    const post = methods && methods.post;
    if (!post) {
      continue;
    }
    const tname = post.operationId || path.replace(/^\//, '');
    if (!TOOL_ALLOW.has(tname)) {
      continue;
    }
    const low = tname.toLowerCase();
    if (DENY_SUBSTR.some((s) => low.includes(s)) && !MUTATING_ALLOW.has(tname)) {
      continue; // mutating verb, never expose over voice unless explicitly opted in
    }
    let schema =
      ((((post.requestBody || {}).content || {})['application/json'] || {}).schema) || {};
    // Azure realtime rejects anyOf / additionalProperties:true (-> 500 -> 502).
    let params = schema && Object.keys(schema).length ? sanitizeToolSchema(schema) : {};
    if (!params || params.type !== 'object') {
      params = { type: 'object', properties: {}, additionalProperties: false };
    }
    if (!params.properties) {
      params.properties = {};
    }
    params.additionalProperties = false;
    const desc = (post.summary || post.description || tname).trim().slice(0, 300);
    defs.push({ type: 'function', name: tname, description: desc, parameters: params });
    dispatch[tname] = {
      serverName,
      url,
      path,
      mutating: MUTATING_ALLOW.has(tname),
    };
  }
  return { defs, dispatch };
}

function mergeLoadedTools(loadedServers) {
  const definitions = new Map();
  const dispatch = {};
  const ambiguous = new Set();
  for (const loaded of loadedServers) {
    for (const definition of loaded.defs) {
      const name = definition.name;
      if (ambiguous.has(name)) {
        continue;
      }
      if (definitions.has(name)) {
        definitions.delete(name);
        delete dispatch[name];
        ambiguous.add(name);
        continue;
      }
      definitions.set(name, definition);
      dispatch[name] = loaded.dispatch[name];
    }
  }
  return { defs: [...definitions.values()], dispatch };
}

// Lazy, throttled load with last-good caching: a transient blip never drops a
// working server's tools, and an unreachable server can't add latency to every
// /session call.
async function loadTools(force = false) {
  if (!MCP_SERVERS.length) {
    toolsLoaded = true;
    return;
  }
  const nowMs = Date.now();
  if (!force && toolsLoaded && nowMs - toolsLoadAttempt < 30000) {
    return;
  }
  toolsLoadAttempt = nowMs;
  const loadedServers = [];
  let complete = true;
  for (const { name, url } of MCP_SERVERS) {
    try {
      const loaded = await loadOneServer(name, url);
      loadedServers.push(loaded);
      logger.info(`[realtime] MCP ${name}: loaded ${loaded.defs.length} tool(s)`);
    } catch (err) {
      complete = false;
      logger.warn(`[realtime] MCP load failed for ${name}: ${err.message}`);
    }
  }
  if (!complete) {
    if (!toolsLoaded) {
      toolDefs = [];
      toolDispatch = {};
    }
    toolsLoaded = true;
    return;
  }
  const merged = mergeLoadedTools(loadedServers);
  toolDefs = merged.defs.slice(0, TOOL_MAX);
  toolDispatch = Object.fromEntries(
    toolDefs.map((definition) => [definition.name, merged.dispatch[definition.name]]),
  );
  toolsLoaded = true;
}

if (process.env.NODE_ENV === 'test') {
  router._test = {
    parseMcpServers,
    parseActionTokenEnvs,
    mergeLoadedTools,
    loadTools,
    resetTools() {
      toolDefs = [];
      toolDispatch = {};
      toolsLoaded = false;
      toolsLoadAttempt = 0;
    },
    toolState() {
      return { definitions: toolDefs.slice(), dispatch: { ...toolDispatch } };
    },
  };
}

router.get('/config', async (req, res) => {
  if (isEnabled()) {
    await loadTools().catch(() => {});
  }
  const tools = await toolsForUser(req.user);
  res.json({
    enabled: isEnabled(),
    deployment: AZURE_REALTIME_DEPLOYMENT,
    voice: REALTIME_VOICE,
    toolCount: tools.length + (MEMORY_ENABLED ? 1 : 0) + (WEB_SEARCH_ENABLED ? 1 : 0),
    memory: MEMORY_ENABLED,
  });
});

router.post('/session', async (req, res) => {
  if (!isEnabled()) {
    return res.status(501).json({ error: 'Realtime voice is not configured on this server.' });
  }

  await loadTools().catch(() => {});

  // Per-user memory recall: prepend what we know about THIS user to the prompt.
  let instructions = REALTIME_INSTRUCTIONS;
  const memoryText = await loadMemoryText(req.user?.id);
  if (memoryText) {
    instructions +=
      '\n\nWhat you already know about this user (from past conversations):\n'
      + memoryText
      + '\n\nUse this naturally; do not read it back verbatim.';
  }

  // Continue the SAME chat over voice: prepend the open thread's history so the
  // voice model picks up with full context instead of starting blank.
  const historyText = await loadConversationText(req.user?.id, req.body?.conversationId);
  if (historyText) {
    instructions +=
      '\n\nThe ongoing conversation in THIS chat so far (continue it seamlessly, keep full context, do not repeat it back):\n'
      + historyText;
  }

  const session = {
    type: 'realtime',
    model: AZURE_REALTIME_DEPLOYMENT,
    instructions,
    audio: {
      input: {
        // REQUIRED for ChatGPT-style USER transcripts: without an input
        // transcription model, the realtime API never emits
        // `conversation.item.input_audio_transcription.completed`, so the
        // user's spoken turns would never appear in the thread.
        transcription: { model: process.env.AZURE_REALTIME_TRANSCRIBE_MODEL || 'whisper-1' },
        // Server-side voice activity detection: the model decides turn
        // boundaries and handles barge-in/interruption automatically.
        turn_detection: { type: 'server_vad' },
      },
      output: {
        voice: REALTIME_VOICE,
      },
    },
  };

  // Deterministic tool order so the instructions+tools prefix stays byte-stable
  // across sessions — that prefix is the only part Azure realtime prompt caching
  // can reuse (the accumulating audio context is never cacheable). MCP discovery
  // order must not perturb it, so sort by name. Memory + web-search tools are
  // appended in a fixed order after.
  const tools = (await toolsForUser(req.user))
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (MEMORY_ENABLED) {
    tools.push(MEMORY_TOOL);
  }
  if (WEB_SEARCH_ENABLED && WEB_SEARCH_URL) {
    tools.push(WEB_SEARCH_TOOL);
  }
  if (tools.length) {
    session.tools = tools;
    session.tool_choice = 'auto';
  }

  const sessionConfig = { session };

  try {
    const url = `${AZURE_REALTIME_ENDPOINT}/openai/v1/realtime/client_secrets`;
    const response = await axios.post(url, sessionConfig, {
      headers: { 'api-key': AZURE_REALTIME_API_KEY, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    const token = response.data?.value;
    if (!token) {
      logger.error('[realtime/session] Azure response missing ephemeral token');
      return res.status(502).json({ error: 'Realtime token unavailable.' });
    }
    return res.json({
      token,
      endpoint: AZURE_REALTIME_ENDPOINT,
      deployment: AZURE_REALTIME_DEPLOYMENT,
      webrtcUrl: `${AZURE_REALTIME_ENDPOINT}/openai/v1/realtime/calls`,
      expiresAt: response.data?.expires_at ?? null,
      // When NO tools are exposed we can keep the prompt private with
      // webrtcfilter=on; with tools we must receive the function-call events on
      // the data channel, so the filter is dropped (the prompt is not a secret
      // for this household app — the ephemeral token remains the boundary).
      filterEvents: tools.length === 0,
    });
  } catch (err) {
    // Never leak the Azure key or upstream body verbatim to the client.
    logger.error(
      '[realtime/session] token mint failed:',
      err?.response?.status,
      err?.response?.data || err.message,
    );
    return res.status(502).json({ error: 'Failed to start a realtime session.' });
  }
});

// Relay a realtime function call to its owning in-cluster MCP server. The
// model decided to call it; the browser forwards {name, arguments} here (with
// the user's JWT), and we execute it server-side. Only allow-listed,
// deny-net-passing tools were ever advertised, so an unknown name is rejected.
router.post('/tool', async (req, res) => {
  if (!isEnabled()) {
    return res.status(501).json({ output: 'Voice is not configured on this server.' });
  }
  await loadTools().catch(() => {});
  let { name, arguments: args } = req.body || {};
  // Built-in memory tool (not an MCP server): write to the user's native store.
  if (name === 'memory_save') {
    if (!MEMORY_ENABLED) {
      return res.status(400).json({ output: 'Memory is not enabled.' });
    }
    let a = args;
    if (typeof a === 'string') {
      try {
        a = a.trim() ? JSON.parse(a) : {};
      } catch {
        a = {};
      }
    }
    if (!a || typeof a !== 'object') {
      a = {};
    }
    const output = await saveMemory(req.user?.id, a.key, a.value);
    return res.json({ output });
  }
  // Built-in web search (not an MCP server): free in-cluster SearXNG.
  if (name === 'web_search') {
    if (!WEB_SEARCH_ENABLED) {
      return res.status(400).json({ output: 'Web search is not enabled.' });
    }
    let a = args;
    if (typeof a === 'string') {
      try {
        a = a.trim() ? JSON.parse(a) : {};
      } catch {
        a = {};
      }
    }
    if (!a || typeof a !== 'object') {
      a = {};
    }
    const output = await searchWeb(a.query);
    return res.json({ output: (output || '').slice(0, TOOL_CALL_CHARS) || 'No data returned.' });
  }
  const target = toolDispatch[name];
  if (!target) {
    return res.status(400).json({ output: `Unknown tool: ${name}` });
  }
  const email = await resolveUserEmail(req.user);
  if (!isServerAllowedForUser(target.serverName, email)) {
    return res.status(403).json({ output: 'That tool is not available for this user.' });
  }
  const actionHeaders = mutationHeaders(target);
  if (actionHeaders === null) {
    return res.status(503).json({ output: 'That mutation is not configured.' });
  }
  if (typeof args === 'string') {
    try {
      args = args.trim() ? JSON.parse(args) : {};
    } catch {
      args = {};
    }
  }
  if (!args || typeof args !== 'object') {
    args = {};
  }
  try {
    const r = await axios.post(`${target.url}${target.path}`, args, {
      headers: { 'Content-Type': 'application/json', ...actionHeaders },
      timeout: 20000,
    });
    const text = coerceText(r.data);
    return res.json({ output: (text || '').slice(0, TOOL_CALL_CHARS) || 'No data returned.' });
  } catch (err) {
    logger.warn(`[realtime/tool] ${name} failed: ${err?.response?.status || ''} ${err.message}`);
    return res.json({ output: 'That tool is unavailable right now.' });
  }
});

router.post('/transcript', async (req, res) => {
  const {
    conversationId,
    userText,
    assistantText,
    userMessageId,
    assistantMessageId,
    parentMessageId = null,
    // Explicit per-message parents (preferred): the client owns the chain and
    // sends a strictly LINEAR parent for each message. Falling back to the
    // legacy single parentMessageId keeps older clients working.
    userParentMessageId,
    assistantParentMessageId,
    endpoint,
    endpointType,
    model,
    agentId,
    spec,
  } = req.body || {};

  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required.' });
  }

  const userId = userMessageId || randomUUID();
  const assistantId = assistantMessageId || randomUUID();

  // Decide a ROUTABLE attribution so the conversation is continuable by text.
  // - A non-"agents" custom endpoint with a model the user was already on is
  //   kept (e.g. "Homelab" + claude-*).
  // - "agents" WITH a real agent_id is kept (the agent is routable).
  // - Anything else (no endpoint, or "agents" with no agent — the voice default,
  //   which is UNROUTABLE for a typed turn) falls back to the known-good chat
  //   endpoint+model. Never the realtime speech deployment.
  const usableCustom = endpoint && endpoint !== 'agents';
  const usableAgent = endpoint === 'agents' && !!agentId;
  let attribution;
  if (usableCustom) {
    attribution = {
      endpoint,
      ...(endpointType ? { endpointType } : {}),
      model: model || REALTIME_CHAT_MODEL,
      ...(spec ? { spec } : {}),
    };
  } else if (usableAgent) {
    attribution = { endpoint: 'agents', agent_id: agentId, ...(spec ? { spec } : {}) };
  } else {
    attribution = { endpoint: REALTIME_CHAT_ENDPOINT, model: REALTIME_CHAT_MODEL };
  }
  const convoFields = { ...attribution };

  try {
    let savedUser = false;
    if (typeof userText === 'string' && userText.trim()) {
      await saveMessage(
        req,
        {
          conversationId,
          messageId: userId,
          parentMessageId: userParentMessageId ?? parentMessageId ?? null,
          sender: 'User',
          text: userText.trim(),
          isCreatedByUser: true,
          endpoint: attribution.endpoint,
        },
        { context: 'realtime/transcript:user' },
      );
      savedUser = true;
    }

    let savedAssistant = false;
    if (typeof assistantText === 'string' && assistantText.trim()) {
      // Linear chain: prefer the explicit assistant parent; else chain to the
      // user turn just saved; else the legacy parent. Never cross-link.
      const aParent =
        assistantParentMessageId ?? (savedUser ? userId : parentMessageId ?? null);
      await saveMessage(
        req,
        {
          conversationId,
          messageId: assistantId,
          parentMessageId: aParent,
          sender: 'Assistant',
          text: assistantText.trim(),
          isCreatedByUser: false,
          endpoint: attribution.endpoint,
          ...(attribution.model ? { model: attribution.model } : {}),
        },
        { context: 'realtime/transcript:assistant' },
      );
      savedAssistant = true;
    }

    // Best-effort: ensure the conversation row exists / is bumped so the turn
    // shows in the sidebar. Failure here must not lose the saved messages.
    // Only the user's real endpoint/model/agent are written (never the realtime
    // deployment), so the conversation stays continuable by text.
    try {
      await saveConvo(
        req,
        {
          conversationId,
          ...convoFields,
        },
        { context: 'realtime/transcript' },
      );
    } catch (convoErr) {
      logger.warn('[realtime/transcript] saveConvo best-effort failed:', convoErr.message);
    }

    return res.json({
      userMessageId: userId,
      assistantMessageId: assistantId,
      savedUser,
      savedAssistant,
    });
  } catch (err) {
    logger.error('[realtime/transcript] save failed:', err.message);
    return res.status(500).json({ error: 'Failed to save the voice transcript.' });
  }
});

module.exports = router;
