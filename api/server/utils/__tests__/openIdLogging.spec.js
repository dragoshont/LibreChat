const {
  formatOpenIdBodyForLogging,
  formatOpenIdHeadersForLogging,
} = require('../openIdLogging');

describe('OpenID debug logging', () => {
  test('masks every token-exchange credential in URL-encoded bodies', () => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_secret: 'client-secret-value',
      refresh_token: 'refresh-token-value',
      code: 'authorization-code-value',
      assertion: 'obo-assertion-value',
      scope: 'openid profile',
    });

    const output = formatOpenIdBodyForLogging(body);

    expect(output).toContain('openid profile');
    for (const secret of [
      'client-secret-value',
      'refresh-token-value',
      'authorization-code-value',
      'obo-assertion-value',
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  test('masks authorization, cookies, and credential-shaped headers', () => {
    const headers = new Headers({
      Authorization: 'Bearer user-token',
      Cookie: 'session=secret',
      'X-Api-Key': 'api-key-value',
      Accept: 'application/json',
    });

    const output = formatOpenIdHeadersForLogging(headers);

    expect(output).toContain('application/json');
    expect(output).not.toContain('user-token');
    expect(output).not.toContain('session=secret');
    expect(output).not.toContain('api-key-value');
  });

  test('omits non-form structured bodies instead of serializing them', () => {
    expect(formatOpenIdBodyForLogging({ access_token: 'secret' })).toBe(
      '[object request body omitted]',
    );
  });
});