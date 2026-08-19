const { createHash } = require('node:crypto');

// Downstream connectors add tool name, phase, and canonical payload to this
// message-scoped value before using it as an idempotency key.
function deriveMCPInvocationId({ threadId, parentMessageId }) {
  const parts = [threadId, parentMessageId];
  if (!parts.every((part) => typeof part === 'string' && part.length > 0)) {
    return undefined;
  }
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `lc-${digest}`;
}

module.exports = { deriveMCPInvocationId };
