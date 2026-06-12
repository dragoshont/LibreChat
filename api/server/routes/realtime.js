const express = require('express');
const axios = require('axios');
const { randomUUID } = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { saveMessage, saveConvo } = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');

/**
 * Realtime voice (WebRTC) routes.
 *
 * Architecture (see .github/skills/librechat-voice): the browser opens a WebRTC
 * peer connection DIRECTLY to Azure OpenAI's realtime endpoint for low-latency
 * speech-to-speech. This server's only jobs are:
 *   1. POST /api/realtime/session  — mint a short-lived (≈60s) EPHEMERAL client
 *      secret per authenticated user. The standing Azure API key NEVER leaves
 *      the server; only the ephemeral token (single realtime-call scope) is
 *      returned to the browser. This is the Azure/OpenAI-documented pattern.
 *   2. POST /api/realtime/transcript — persist a completed voice turn (the user
 *      utterance + the assistant reply transcript) into the user's conversation
 *      so voice turns appear in the thread exactly like typed messages and
 *      survive reload. Strictly scoped to req.user.id (a user only ever writes
 *      to their own threads).
 *   3. GET  /api/realtime/config — feature-flag probe so the client can hide the
 *      voice button when realtime isn't configured. Kept separate from
 *      /api/config to avoid touching that route's strict (zod) schema.
 *
 * All routes require JWT auth (per-user identity, no shared token).
 */

const router = express.Router();
router.use(requireJwtAuth);

const AZURE_REALTIME_ENDPOINT = (process.env.AZURE_REALTIME_ENDPOINT || '').replace(/\/+$/, '');
const AZURE_REALTIME_API_KEY = process.env.AZURE_REALTIME_API_KEY || '';
const AZURE_REALTIME_DEPLOYMENT = process.env.AZURE_REALTIME_DEPLOYMENT || 'gpt-realtime-1-5';
const REALTIME_VOICE = process.env.AZURE_REALTIME_VOICE || 'marin';
const REALTIME_INSTRUCTIONS =
  process.env.AZURE_REALTIME_INSTRUCTIONS ||
  'You are a helpful, concise voice assistant. Speak naturally and keep responses brief.';

const isEnabled = () => Boolean(AZURE_REALTIME_ENDPOINT && AZURE_REALTIME_API_KEY);

router.get('/config', (req, res) => {
  res.json({
    enabled: isEnabled(),
    deployment: AZURE_REALTIME_DEPLOYMENT,
    voice: REALTIME_VOICE,
  });
});

router.post('/session', async (req, res) => {
  if (!isEnabled()) {
    return res.status(501).json({ error: 'Realtime voice is not configured on this server.' });
  }

  // Per-user instructions could be customized here using req.user; kept simple
  // for v1. webrtcfilter=on (applied client-side on the calls URL) keeps these
  // instructions off the browser data channel while still emitting transcripts.
  const sessionConfig = {
    session: {
      type: 'realtime',
      model: AZURE_REALTIME_DEPLOYMENT,
      instructions: REALTIME_INSTRUCTIONS,
      audio: {
        input: {
          // REQUIRED for ChatGPT-style USER transcripts: without an input
          // transcription model, the realtime API never emits
          // `conversation.item.input_audio_transcription.completed`, so the
          // user's spoken turns would never appear in the thread.
          transcription: { model: process.env.AZURE_REALTIME_TRANSCRIBE_MODEL || 'whisper-1' },
          // Server-side voice activity detection: the model decides turn
          // boundaries and handles barge-in/interruption automatically.
          turn_detection: { type: 'server_vad' },
        },
        output: {
          voice: REALTIME_VOICE,
        },
      },
    },
  };

  try {
    const url = `${AZURE_REALTIME_ENDPOINT}/openai/v1/realtime/client_secrets`;
    const response = await axios.post(url, sessionConfig, {
      headers: { 'api-key': AZURE_REALTIME_API_KEY, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    const token = response.data?.value;
    if (!token) {
      logger.error('[realtime/session] Azure response missing ephemeral token');
      return res.status(502).json({ error: 'Realtime token unavailable.' });
    }
    return res.json({
      token,
      endpoint: AZURE_REALTIME_ENDPOINT,
      deployment: AZURE_REALTIME_DEPLOYMENT,
      webrtcUrl: `${AZURE_REALTIME_ENDPOINT}/openai/v1/realtime/calls`,
      expiresAt: response.data?.expires_at ?? null,
    });
  } catch (err) {
    // Never leak the Azure key or upstream body verbatim to the client.
    logger.error(
      '[realtime/session] token mint failed:',
      err?.response?.status,
      err?.response?.data || err.message,
    );
    return res.status(502).json({ error: 'Failed to start a realtime session.' });
  }
});

router.post('/transcript', async (req, res) => {
  const {
    conversationId,
    userText,
    assistantText,
    userMessageId,
    assistantMessageId,
    parentMessageId = null,
    endpoint,
    model,
  } = req.body || {};

  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required.' });
  }

  const userId = userMessageId || randomUUID();
  const assistantId = assistantMessageId || randomUUID();
  const resolvedModel = model || AZURE_REALTIME_DEPLOYMENT;

  try {
    let savedUser = false;
    if (typeof userText === 'string' && userText.trim()) {
      await saveMessage(
        req,
        {
          conversationId,
          messageId: userId,
          parentMessageId: parentMessageId || null,
          sender: 'User',
          text: userText.trim(),
          isCreatedByUser: true,
          ...(endpoint ? { endpoint } : {}),
        },
        { context: 'realtime/transcript:user' },
      );
      savedUser = true;
    }

    let savedAssistant = false;
    if (typeof assistantText === 'string' && assistantText.trim()) {
      await saveMessage(
        req,
        {
          conversationId,
          messageId: assistantId,
          parentMessageId: savedUser ? userId : parentMessageId || null,
          sender: 'Assistant',
          text: assistantText.trim(),
          isCreatedByUser: false,
          model: resolvedModel,
          ...(endpoint ? { endpoint } : {}),
        },
        { context: 'realtime/transcript:assistant' },
      );
      savedAssistant = true;
    }

    // Best-effort: ensure the conversation row exists / is bumped so the turn
    // shows in the sidebar. Failure here must not lose the saved messages.
    try {
      await saveConvo(
        req,
        {
          conversationId,
          ...(endpoint ? { endpoint } : {}),
          model: resolvedModel,
        },
        { context: 'realtime/transcript' },
      );
    } catch (convoErr) {
      logger.warn('[realtime/transcript] saveConvo best-effort failed:', convoErr.message);
    }

    return res.json({
      userMessageId: userId,
      assistantMessageId: assistantId,
      savedUser,
      savedAssistant,
    });
  } catch (err) {
    logger.error('[realtime/transcript] save failed:', err.message);
    return res.status(500).json({ error: 'Failed to save the voice transcript.' });
  }
});

module.exports = router;
