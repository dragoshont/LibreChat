jest.mock('jwks-rsa', () => ({
  passportJwtSecret: jest.fn(() => 'secret-provider'),
}));

jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn(() => false),
  findOpenIDUser: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn() },
}));

jest.mock('~/models', () => ({
  updateUser: jest.fn(),
  findUser: jest.fn(),
}));

const { Strategy } = require('passport-jwt');
const openIdJwtLogin = require('./openIdJwtStrategy');

jest.mock('passport-jwt', () => ({
  ExtractJwt: { fromAuthHeaderAsBearerToken: jest.fn(() => 'extractor') },
  Strategy: jest.fn((options) => ({ options })),
}));

describe('openIdJwtStrategy', () => {
  test('pins reused access tokens to configured issuer and client audience', () => {
    const strategy = openIdJwtLogin({
      serverMetadata: () => ({
        issuer: 'https://auth.example/application/o/librechat/',
        jwks_uri: 'https://auth.example/jwks',
      }),
      clientMetadata: () => ({ client_id: 'librechat-client' }),
    });

    expect(Strategy).toHaveBeenCalled();
    expect(strategy.options).toMatchObject({
      issuer: 'https://auth.example/application/o/librechat/',
      audience: 'librechat-client',
      jwtFromRequest: 'extractor',
      secretOrKeyProvider: 'secret-provider',
    });
  });

  test.each([
    [{ issuer: '', jwks_uri: 'https://auth.example/jwks' }, { client_id: 'client' }],
    [{ issuer: 'https://auth.example/issuer', jwks_uri: 'https://auth.example/jwks' }, { client_id: '' }],
  ])('fails closed when issuer or audience is absent', (server, client) => {
    expect(() => openIdJwtLogin({
      serverMetadata: () => server,
      clientMetadata: () => client,
    })).toThrow('requires the configured issuer and client audience');
  });
});