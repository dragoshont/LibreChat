const { createHash } = require('node:crypto');

function deriveMCPInvocationId({ threadId, runId, toolCallId }) {
  const parts = [threadId, runId, toolCallId];
  if (!parts.every((part) => typeof part === 'string' && part.length > 0)) {
    return undefined;
  }
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `lc-${digest}`;
}

module.exports = { deriveMCPInvocationId };