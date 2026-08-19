const { deriveMCPInvocationId } = require('../mcpInvocationId');

describe('deriveMCPInvocationId', () => {
  test('is stable when regenerating the same user message', () => {
    const input = { threadId: 'thread-1', parentMessageId: 'user-message-1' };
    expect(deriveMCPInvocationId(input)).toBe(deriveMCPInvocationId(input));
  });

  test('separates distinct user-message intents', () => {
    const first = deriveMCPInvocationId({
      threadId: 'thread-1',
      parentMessageId: 'user-message-1',
    });
    const second = deriveMCPInvocationId({
      threadId: 'thread-1',
      parentMessageId: 'user-message-2',
    });
    expect(first).toMatch(/^lc-[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  test('returns no ID when logical call context is incomplete', () => {
    expect(deriveMCPInvocationId({ threadId: 'thread-1' })).toBeUndefined();
  });
});
