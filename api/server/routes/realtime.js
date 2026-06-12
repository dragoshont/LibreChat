const express = require('express');
const axios = require('axios');
const { randomUUID } = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { saveMessage, saveConvo, getAllUserMemories, setMemory } = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');

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
// explicitly opted into REALTIME_MUTATING_ALLOW (a deliberate,
// confirmation-gated exception — e.g. rm_create_appointment, which the RM MCP
// refuses unless confirm=true AND the prompt makes the model read back the slot
// and get a spoken "yes" first).
//   REALTIME_MCP_SERVERS:    comma-separated `name=url[,name=url]`
//   REALTIME_TOOL_ALLOW:     comma-separated allowed operationIds
//   REALTIME_MUTATING_ALLOW: comma-separated write tools allowed as exceptions
const MCP_SERVERS = (process.env.REALTIME_MCP_SERVERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const idx = entry.indexOf('=');
    if (idx < 0) {
      return null;
    }
    const name = entry.slice(0, idx).trim();
    const url = entry.slice(idx + 1).trim().replace(/\/+$/, '');
    return name && url ? { name, url } : null;
  })
  .filter(Boolean);
const TOOL_ALLOW = new Set(
  (process.env.REALTIME_TOOL_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean),
);
const MUTATING_ALLOW = new Set(
  (process.env.REALTIME_MUTATING_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean),
);
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

let toolDefs = [];
let toolDispatch = {}; // name -> { url, path }
let toolsLoaded = false;
let toolsLoadAttempt = 0;

function cleanSchema(node) {
  if (Array.isArray(node)) {
    return node.map(cleanSchema);
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'title') {
        continue;
      }
      out[k] = cleanSchema(v);
    }
    return out;
  }
  return node;
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

async function loadOneServer(url) {
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
    let params = schema && Object.keys(schema).length ? cleanSchema(schema) : {};
    if (!params || params.type !== 'object') {
      params = { type: 'object', properties: {} };
    }
    if (!params.properties) {
      params.properties = {};
    }
    const desc = (post.summary || post.description || tname).trim().slice(0, 300);
    defs.push({ type: 'function', name: tname, description: desc, parameters: params });
    dispatch[tname] = { url, path };
  }
  return { defs, dispatch };
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
  const defs = [];
  const dispatch = {};
  for (const { name, url } of MCP_SERVERS) {
    try {
      const loaded = await loadOneServer(url);
      for (const d of loaded.defs) {
        if (!dispatch[d.name]) {
          defs.push(d);
        }
      }
      Object.assign(dispatch, loaded.dispatch);
      logger.info(`[realtime] MCP ${name}: loaded ${loaded.defs.length} tool(s)`);
    } catch (err) {
      logger.warn(`[realtime] MCP load failed for ${name}: ${err.message}`);
    }
  }
  if (defs.length || !toolsLoaded) {
    toolDefs = defs.slice(0, TOOL_MAX);
    toolDispatch = dispatch;
  }
  toolsLoaded = true;
}

router.get('/config', async (req, res) => {
  if (isEnabled()) {
    await loadTools().catch(() => {});
  }
  res.json({
    enabled: isEnabled(),
    deployment: AZURE_REALTIME_DEPLOYMENT,
    voice: REALTIME_VOICE,
    toolCount: toolDefs.length + (MEMORY_ENABLED ? 1 : 0),
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

  const tools = toolDefs.slice();
  if (MEMORY_ENABLED) {
    tools.push(MEMORY_TOOL);
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
  const target = toolDispatch[name];
  if (!target) {
    return res.status(400).json({ output: `Unknown tool: ${name}` });
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
      headers: { 'Content-Type': 'application/json' },
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
