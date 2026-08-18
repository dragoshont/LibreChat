const { deriveMCPInvocationId } = require('../mcpInvocationId');

describe('deriveMCPInvocationId', () => {
  test('is stable for a retry of the same logical tool call', () => {
    const input = { threadId: 'thread-1', runId: 'run-1', toolCallId: 'call-1' };
    expect(deriveMCPInvocationId(input)).toBe(deriveMCPInvocationId(input));
  });

  test('separates distinct tool-call intents without including their arguments', () => {
    const first = deriveMCPInvocationId({
      threadId: 'thread-1',
      runId: 'run-1',
      toolCallId: 'call-1',
    });
    const second = deriveMCPInvocationId({
      threadId: 'thread-1',
      runId: 'run-1',
      toolCallId: 'call-2',
    });
    expect(first).toMatch(/^lc-[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  test('returns no ID when logical call context is incomplete', () => {
    expect(deriveMCPInvocationId({ threadId: 'thread-1', runId: 'run-1' })).toBeUndefined();
  });
});