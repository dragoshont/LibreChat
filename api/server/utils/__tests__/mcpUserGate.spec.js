const {
  parseGate,
  getServerFromToolName,
  isServerAllowedForUser,
  isToolAllowedForUser,
} = require('../mcpUserGate');

describe('mcpUserGate', () => {
  const originalGate = process.env.MCP_USER_GATE;

  afterEach(() => {
    if (originalGate === undefined) {
      delete process.env.MCP_USER_GATE;
    } else {
      process.env.MCP_USER_GATE = originalGate;
    }
  });

  test('parses semicolon servers and comma-separated emails case-insensitively', () => {
    const gate = parseGate(
      'reginamaria=Owner@Example.com,second@example.com; apple=calendar@example.com',
    );

    expect([...gate.get('reginamaria')]).toEqual([
      'owner@example.com',
      'second@example.com',
    ]);
    expect([...gate.get('apple')]).toEqual(['calendar@example.com']);
  });

  test('ignores malformed and empty assignments', () => {
    const gate = parseGate('missing-equals;=owner@example.com;empty=;valid=owner@example.com');

    expect([...gate.keys()]).toEqual(['valid']);
  });

  test('allows every user for an ungated server', () => {
    process.env.MCP_USER_GATE = 'reginamaria=owner@example.com';

    expect(isServerAllowedForUser('weather', undefined)).toBe(true);
    expect(isServerAllowedForUser('weather', 'other@example.com')).toBe(true);
  });

  test('denies a gated server when identity is missing or does not match', () => {
    process.env.MCP_USER_GATE = 'reginamaria=owner@example.com';

    expect(isServerAllowedForUser('reginamaria', undefined)).toBe(false);
    expect(isServerAllowedForUser('reginamaria', null)).toBe(false);
    expect(isServerAllowedForUser('reginamaria', 'other@example.com')).toBe(false);
  });

  test('matches allowed email without case sensitivity', () => {
    process.env.MCP_USER_GATE = 'reginamaria=owner@example.com';

    expect(isServerAllowedForUser('reginamaria', 'OWNER@EXAMPLE.COM')).toBe(true);
  });

  test('duplicate server declarations fail closed', () => {
    process.env.MCP_USER_GATE =
      'reginamaria=owner@example.com;reginamaria=other@example.com';

    expect(parseGate().get('reginamaria')).toEqual(new Set());
    expect(isServerAllowedForUser('reginamaria', 'owner@example.com')).toBe(false);
    expect(isServerAllowedForUser('reginamaria', 'other@example.com')).toBe(false);
  });

  test('extracts the last MCP delimiter and gates MCP tools only', () => {
    process.env.MCP_USER_GATE = 'reginamaria=owner@example.com';

    expect(getServerFromToolName('prefix_mcp_tool_mcp_reginamaria')).toBe('reginamaria');
    expect(getServerFromToolName('plain-tool')).toBeNull();
    expect(isToolAllowedForUser('rm_cancel_mcp_reginamaria', 'other@example.com')).toBe(false);
    expect(isToolAllowedForUser('plain-tool', 'other@example.com')).toBe(true);
  });
});