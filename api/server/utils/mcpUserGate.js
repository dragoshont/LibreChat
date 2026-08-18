/**
 * Per-user MCP server gating.
 *
 * LibreChat v0.8.0 has no native way to restrict an `mcpServers` entry to
 * specific users — every logged-in user sees every configured MCP server. For
 * the family deployment that is a PRIVACY problem: the Regina Maria (RM) MCP
 * servers each act as a specific person's medical-portal login, so user A must
 * never see or call user B's RM server.
 *
 * This module gates MCP tools to specific user emails via an env allowlist:
 *
 *   MCP_USER_GATE="reginamaria=dragos.hont@gmail.com;reginamaria-manuela=manuela.hont@gmail.com"
 *
 * Format: `server=email[,email...]` entries separated by `;`.
 * A server NOT present in the map is UNGATED (visible to everyone) — so this is
 * fully backwards compatible: with MCP_USER_GATE unset, nothing changes.
 *
 * Enforced in TWO places (defense in depth):
 *   1. Enumeration  — PluginController hides gated tools from the tool list.
 *   2. Execution    — MCP.js refuses a gated tool call from a non-allowed user.
 *
 * MCP tool names are `<tool><mcp_delimiter><server>` (delimiter `_mcp_`), so the
 * server name is the substring after the LAST delimiter.
 */

const MCP_DELIMITER = '_mcp_';

let _cache = null;
let _cacheRaw = null;

/**
 * Parse MCP_USER_GATE into a Map<serverName, Set<lowercased email>>.
 * Cached against the raw string so repeated calls are cheap.
 * @param {string} [raw] - defaults to process.env.MCP_USER_GATE
 * @returns {Map<string, Set<string>>}
 */
function parseGate(raw = process.env.MCP_USER_GATE || '') {
  if (_cache && _cacheRaw === raw) {
    return _cache;
  }
  const map = new Map();
  const ambiguous = new Set();
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const server = trimmed.slice(0, eq).trim();
    const emails = trimmed
      .slice(eq + 1)
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (server && (ambiguous.has(server) || map.has(server))) {
      map.set(server, new Set());
      ambiguous.add(server);
      continue;
    }
    if (server && emails.length) {
      map.set(server, new Set(emails));
    }
  }
  _cache = map;
  _cacheRaw = raw;
  return map;
}

/**
 * Extract the MCP server name from a tool name, or null if not an MCP tool.
 * @param {string} toolName
 * @returns {string|null}
 */
function getServerFromToolName(toolName) {
  if (typeof toolName !== 'string') {
    return null;
  }
  const idx = toolName.lastIndexOf(MCP_DELIMITER);
  if (idx < 0) {
    return null;
  }
  return toolName.slice(idx + MCP_DELIMITER.length);
}

/**
 * Is the given user allowed to access the given MCP server?
 * Ungated servers (not in the map) are allowed for everyone.
 * Gated servers require a matching email.
 * @param {string} serverName
 * @param {string} [userEmail]
 * @returns {boolean}
 */
function isServerAllowedForUser(serverName, userEmail) {
  const gate = parseGate();
  const allowed = gate.get(serverName);
  if (!allowed) {
    return true; // ungated
  }
  if (!userEmail) {
    return false; // gated server, but we can't identify the user -> deny
  }
  return allowed.has(String(userEmail).toLowerCase());
}

/**
 * Is the given user allowed to use the given tool? Non-MCP tools are always
 * allowed; MCP tools are gated by their server.
 * @param {string} toolName
 * @param {string} [userEmail]
 * @returns {boolean}
 */
function isToolAllowedForUser(toolName, userEmail) {
  const server = getServerFromToolName(toolName);
  if (server == null) {
    return true; // not an MCP tool -> not gated
  }
  return isServerAllowedForUser(server, userEmail);
}

module.exports = {
  parseGate,
  getServerFromToolName,
  isServerAllowedForUser,
  isToolAllowedForUser,
};
