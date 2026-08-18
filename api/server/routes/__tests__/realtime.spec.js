const express = require('express');
const request = require('supertest');

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  }),
  { virtual: true },
);

jest.mock('~/models', () => ({
  saveMessage: jest.fn(),
  saveConvo: jest.fn(),
  getMessages: jest.fn().mockResolvedValue([]),
  getAllUserMemories: jest.fn().mockResolvedValue([]),
  setMemory: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = {
      id: req.get('x-test-user-id') || 'owner-id',
      email: req.get('x-test-user-email') || undefined,
    };
    next();
  },
}));

const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { getUserById } = require('~/models');

const openapi = {
  paths: {
    '/rm_list_appointments': {
      post: {
        operationId: 'rm_list_appointments',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      },
    },
    '/rm_create_appointment': {
      post: {
        operationId: 'rm_create_appointment',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      },
    },
    '/rm_cancel_appointment': {
      post: {
        operationId: 'rm_cancel_appointment',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      },
    },
  },
};

describe('realtime MCP authorization', () => {
  let app;
  let internals;
  const serverSpecs = new Map();
  const failedServers = new Set();

  beforeAll(() => {
    process.env.AZURE_REALTIME_ENDPOINT = 'https://realtime.example.test';
    process.env.AZURE_REALTIME_API_KEY = 'synthetic-azure-key';
    process.env.REALTIME_MCP_SERVERS =
      'reginamaria=http://reginamaria.test,secondary=http://secondary.test';
    process.env.REALTIME_TOOL_ALLOW =
      'rm_list_appointments,rm_create_appointment,rm_cancel_appointment';
    process.env.REALTIME_MUTATING_ALLOW = 'rm_create_appointment,rm_cancel_appointment';
    process.env.REALTIME_MCP_ACTION_TOKEN_ENVS = 'reginamaria=RM_TEST_ACTION_TOKEN';
    process.env.RM_TEST_ACTION_TOKEN = 'synthetic-action-token';
    process.env.MCP_USER_GATE = 'reginamaria=owner@example.com;secondary=owner@example.com';

    serverSpecs.set('http://reginamaria.test/openapi.json', openapi);
    serverSpecs.set('http://secondary.test/openapi.json', { paths: {} });
    axios.get.mockImplementation(async (url) => {
      if (failedServers.has(url)) {
        throw new Error('synthetic discovery failure');
      }
      return { data: serverSpecs.get(url) || { paths: {} } };
    });
    getUserById.mockImplementation(async (id) =>
      id === 'owner-id' ? { email: 'owner@example.com' } : null,
    );

    app = express();
    app.use(express.json());
    const realtime = require('../realtime');
    internals = realtime._test;
    app.use('/api/realtime', realtime);
  });

  beforeEach(() => {
    axios.post.mockReset();
    logger.warn.mockClear();
  });

  afterAll(() => {
    delete process.env.RM_TEST_ACTION_TOKEN;
    delete process.env.MCP_USER_GATE;
  });

  test('advertises gated tools only to the owner', async () => {
    const owner = await request(app)
      .get('/api/realtime/config')
      .set('x-test-user-email', 'owner@example.com');
    const other = await request(app)
      .get('/api/realtime/config')
      .set('x-test-user-email', 'other@example.com');

    expect(owner.status).toBe(200);
    expect(owner.body.toolCount).toBe(3);
    expect(other.status).toBe(200);
    expect(other.body.toolCount).toBe(0);
  });

  test('resolves an owner email from the authenticated user id', async () => {
    const response = await request(app)
      .get('/api/realtime/config')
      .set('x-test-user-id', 'owner-id');

    expect(response.body.toolCount).toBe(3);
    expect(getUserById).toHaveBeenCalledWith('owner-id', 'email');
  });

  test.each([
    ['rm_create_appointment', { interval_id: 'interval', physician_id: 'physician' }],
    ['rm_cancel_appointment', { appointment_id: 'appointment' }],
  ])('injects authority after owner mediation for %s', async (name, args) => {
    axios.post.mockResolvedValue({ data: { accepted: true } });

    const response = await request(app)
      .post('/api/realtime/tool')
      .set('x-test-user-email', 'owner@example.com')
      .send({ name, arguments: args });

    expect(response.status).toBe(200);
    expect(axios.post).toHaveBeenCalledWith(`http://reginamaria.test/${name}`, args, {
      headers: {
        'Content-Type': 'application/json',
        'X-Tessera-Action-Token': 'synthetic-action-token',
      },
      timeout: 20000,
    });
    expect(JSON.stringify(axios.post.mock.calls)).not.toContain('_tessera_action_token');
  });

  test('does not send mutation authority on read calls', async () => {
    axios.post.mockResolvedValue({ data: { appointments: [] } });

    const response = await request(app)
      .post('/api/realtime/tool')
      .set('x-test-user-email', 'owner@example.com')
      .send({ name: 'rm_list_appointments', arguments: {} });

    expect(response.status).toBe(200);
    expect(axios.post.mock.calls[0][2].headers).toEqual({
      'Content-Type': 'application/json',
    });
  });

  test('does not log mutation authority when connector dispatch fails', async () => {
    axios.post.mockRejectedValue(new Error('synthetic connector failure'));

    const response = await request(app)
      .post('/api/realtime/tool')
      .set('x-test-user-email', 'owner@example.com')
      .send({
        name: 'rm_cancel_appointment',
        arguments: { appointment_id: 'appointment' },
      });

    expect(response.status).toBe(200);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('synthetic-action-token');
  });

  test.each([
    ['other-id', 'other@example.com'],
    ['unknown-id', null],
  ])('denies an unauthorized identity before dispatch', async (id, email) => {
    const pending = request(app)
      .post('/api/realtime/tool')
      .set('x-test-user-id', id)
      .send({
        name: 'rm_cancel_appointment',
        arguments: { appointment_id: 'appointment' },
      });
    if (email) {
      pending.set('x-test-user-email', email);
    }
    const response = await pending;

    expect(response.status).toBe(403);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('hides and blocks mutations when server authority is unavailable', async () => {
    delete process.env.RM_TEST_ACTION_TOKEN;

    const config = await request(app)
      .get('/api/realtime/config')
      .set('x-test-user-email', 'owner@example.com');
    const call = await request(app)
      .post('/api/realtime/tool')
      .set('x-test-user-email', 'owner@example.com')
      .send({
        name: 'rm_create_appointment',
        arguments: { interval_id: 'interval', physician_id: 'physician' },
      });

    expect(config.body.toolCount).toBe(1);
    expect(call.status).toBe(503);
    expect(axios.post).not.toHaveBeenCalled();
    process.env.RM_TEST_ACTION_TOKEN = 'synthetic-action-token';
  });

  test('does not expose the action credential in the realtime session payload', async () => {
    axios.post.mockResolvedValue({ data: { value: 'ephemeral-token' } });

    const response = await request(app)
      .post('/api/realtime/session')
      .set('x-test-user-email', 'owner@example.com')
      .send({});

    expect(response.status).toBe(200);
    const sessionPayload = axios.post.mock.calls[0][1];
    expect(JSON.stringify(sessionPayload)).not.toContain('synthetic-action-token');
    expect(sessionPayload.session.tools.map((tool) => tool.name)).toEqual([
      'rm_cancel_appointment',
      'rm_create_appointment',
      'rm_list_appointments',
    ]);
  });

  test('does not advertise gated tools in a non-owner realtime session', async () => {
    axios.post.mockResolvedValue({ data: { value: 'ephemeral-token' } });

    const response = await request(app)
      .post('/api/realtime/session')
      .set('x-test-user-email', 'other@example.com')
      .send({});

    expect(response.status).toBe(200);
    expect(axios.post.mock.calls[0][1].session.tools).toBeUndefined();
    expect(response.body.filterEvents).toBe(true);
  });

  test('rejects duplicate server and action-token assignments', () => {
    expect(
      internals.parseMcpServers(
        'reginamaria=http://one.test,reginamaria=http://two.test,other=http://other.test',
      ),
    ).toEqual([{ name: 'other', url: 'http://other.test' }]);
    expect([
      ...internals.parseActionTokenEnvs(
        'reginamaria=RM_ONE,reginamaria=RM_TWO,other=RM_SHARED,third=RM_SHARED',
      ),
    ]).toEqual([]);
  });

  test.each([
    ['reginamaria=http://valid.test,reginamaria='],
    ['reginamaria=,reginamaria=http://valid.test'],
  ])('rejects mixed valid and invalid duplicate server assignments: %s', (config) => {
    expect(internals.parseMcpServers(config)).toEqual([]);
  });

  test.each([
    ['reginamaria=RM_TOKEN,reginamaria=bad-name'],
    ['reginamaria=bad-name,reginamaria=RM_TOKEN'],
  ])('rejects mixed valid and invalid duplicate action mappings: %s', (config) => {
    expect([...internals.parseActionTokenEnvs(config)]).toEqual([]);
  });

  test('suppresses operation IDs owned by more than one server', () => {
    const definition = { name: 'rm_cancel_appointment' };
    const merged = internals.mergeLoadedTools([
      {
        defs: [definition],
        dispatch: { rm_cancel_appointment: { serverName: 'one' } },
      },
      {
        defs: [definition],
        dispatch: { rm_cancel_appointment: { serverName: 'two' } },
      },
    ]);

    expect(merged.defs).toEqual([]);
    expect(merged.dispatch).toEqual({});
  });

  test('exposes no startup catalog after partial discovery and recovers atomically', async () => {
    internals.resetTools();
    failedServers.add('http://secondary.test/openapi.json');

    await internals.loadTools(true);
    expect(internals.toolState()).toEqual({ definitions: [], dispatch: {} });

    failedServers.clear();
    await internals.loadTools(true);
    expect(internals.toolState().definitions).toHaveLength(3);
  });

  test('retains the last complete catalog through a later partial discovery', async () => {
    internals.resetTools();
    await internals.loadTools(true);
    const complete = internals.toolState();
    failedServers.add('http://secondary.test/openapi.json');

    await internals.loadTools(true);
    expect(internals.toolState()).toEqual(complete);
    failedServers.clear();
  });
});
