const SENSITIVE_NAME = /authorization|assertion|code|cookie|key|password|secret|token/i;

function formatOpenIdHeadersForLogging(headers) {
  if (!headers || typeof headers.entries !== 'function') {
    return 'No headers available';
  }
  const output = {};
  for (const [name, value] of headers.entries()) {
    output[name] = SENSITIVE_NAME.test(name) ? '***MASKED***' : value;
  }
  return JSON.stringify(output);
}

function formatOpenIdBodyForLogging(body) {
  let params;
  if (body instanceof URLSearchParams) {
    params = body;
  } else if (typeof body === 'string' && body.includes('=')) {
    params = new URLSearchParams(body);
  } else {
    return `[${typeof body} request body omitted]`;
  }
  const output = {};
  for (const [name, value] of params.entries()) {
    output[name] = SENSITIVE_NAME.test(name) ? '***MASKED***' : value;
  }
  return JSON.stringify(output);
}

module.exports = { formatOpenIdBodyForLogging, formatOpenIdHeadersForLogging };