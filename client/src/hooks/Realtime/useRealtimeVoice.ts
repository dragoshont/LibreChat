import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { request, Constants, QueryKeys } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';

/**
 * useRealtimeVoice — client-orchestrated WebRTC realtime voice for LibreChat.
 *
 * The browser opens a WebRTC peer connection DIRECTLY to Azure OpenAI's realtime
 * endpoint (lowest latency, P2P audio). This hook:
 *   1. mints a per-user EPHEMERAL token from our own `/api/realtime/session`
 *      (the standing Azure key never reaches the browser),
 *   2. streams mic audio up + model audio down over the peer connection,
 *   3. reads transcript events off the data channel and renders them LIVE into
 *      the current conversation (ChatGPT-style), and
 *   4. persists each completed turn to MongoDB via `/api/realtime/transcript`
 *      using the SAME message ids it rendered optimistically, so the thread and
 *      the database never diverge. On stop it reconciles from the DB.
 *
 * webrtcfilter=on keeps the system prompt off the browser data channel; the
 * three transcript events we rely on are still delivered.
 */

export type RealtimeStatus = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error';

type SessionResponse = {
  token: string;
  endpoint: string;
  deployment: string;
  webrtcUrl: string;
  expiresAt: number | null;
  // false when tools are advertised (we then need the function-call events on
  // the data channel, so webrtcfilter must be OFF). true/undefined => filter on.
  filterEvents?: boolean;
};

interface UseRealtimeVoiceParams {
  conversationId?: string | null;
  endpoint?: string | null;
  endpointType?: string | null;
  model?: string | null;
  agentId?: string | null;
  spec?: string | null;
  getMessages: () => TMessage[] | undefined;
  setMessages: (messages: TMessage[]) => void;
  onError?: (message: string) => void;
}

const now = () => new Date().toISOString();

export default function useRealtimeVoice({
  conversationId,
  endpoint,
  endpointType,
  model,
  agentId,
  spec,
  getMessages,
  setMessages,
  onError,
}: UseRealtimeVoiceParams) {
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const [userCaption, setUserCaption] = useState('');
  const [assistantCaption, setAssistantCaption] = useState('');

  const queryClient = useQueryClient();

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  // The conversation id the turns are written to (generated if we start voice
  // from a brand-new chat so persistence has a stable target).
  const convoIdRef = useRef<string>('');
  // Messages present in the thread when the session started — voice turns are
  // appended after these so we never clobber prior history.
  const baseMessagesRef = useRef<TMessage[]>([]);
  // Voice turns created this session (kept separate for clean re-renders).
  const turnsRef = useRef<TMessage[]>([]);
  // Parent-id chain so the thread tree is well-formed.
  const lastIdRef = useRef<string>(Constants.NO_PARENT);
  // The PERSISTED chain head — the id the next persisted message links to.
  // Advanced ONLY at persist time so the saved thread is a strict linear chain
  // (event-time parents race under server-VAD + the assistant-greets-first flow
  // and could otherwise cross-link into a cycle that breaks the conversation).
  const chainHeadRef = useRef<string>(Constants.NO_PARENT);

  // Current in-flight turn bookkeeping.
  const userTextRef = useRef('');
  const userIdRef = useRef<string | null>(null);
  const userParentRef = useRef<string>(Constants.NO_PARENT);
  const assistantTextRef = useRef('');
  const assistantIdRef = useRef<string | null>(null);

  // Tool-call relay bookkeeping (dedupe by call_id; trigger one response.create
  // once every in-flight tool call for the turn has been answered).
  const toolHandledRef = useRef<Set<string>>(new Set());
  const toolNamesRef = useRef<Record<string, string>>({});
  const pendingToolRef = useRef(0);

  const genId = () =>
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const render = useCallback(() => {
    try {
      setMessages([...baseMessagesRef.current, ...turnsRef.current]);
    } catch {
      /* never let a render glitch tear down the session */
    }
  }, [setMessages]);

  const upsertTurn = useCallback(
    (msg: TMessage) => {
      const idx = turnsRef.current.findIndex((m) => m.messageId === msg.messageId);
      if (idx >= 0) {
        turnsRef.current[idx] = msg;
      } else {
        turnsRef.current.push(msg);
      }
      render();
    },
    [render],
  );

  const makeMessage = useCallback(
    (opts: { messageId: string; parentMessageId: string; text: string; isCreatedByUser: boolean; unfinished?: boolean }): TMessage =>
      ({
        messageId: opts.messageId,
        conversationId: convoIdRef.current,
        parentMessageId: opts.parentMessageId,
        sender: opts.isCreatedByUser ? 'User' : 'Assistant',
        text: opts.text,
        isCreatedByUser: opts.isCreatedByUser,
        error: false,
        unfinished: opts.unfinished ?? false,
        createdAt: now(),
        updatedAt: now(),
      }) as TMessage,
    [],
  );

  const persistTurn = useCallback(
    async (assistantFinalText: string) => {
      if (!convoIdRef.current) {
        return;
      }
      const hasUser = !!(userTextRef.current && userTextRef.current.trim());
      const hasAssistant = !!(assistantFinalText && assistantFinalText.trim());
      if (!hasUser && !hasAssistant) {
        return;
      }
      const uId = userIdRef.current ?? undefined;
      const aId = assistantIdRef.current ?? undefined;
      // Strict linear chain decided HERE: user links to the current head, the
      // assistant links to the user (or the head if there was no user turn,
      // e.g. the assistant's opening greeting). Then advance the head. A new
      // genId can only ever point at an OLDER id, so a cycle is impossible.
      const head = chainHeadRef.current;
      const userParentMessageId = head;
      const assistantParentMessageId = hasUser && uId ? uId : head;
      if (hasAssistant && aId) {
        chainHeadRef.current = aId;
      } else if (hasUser && uId) {
        chainHeadRef.current = uId;
      }
      try {
        await request.post('/api/realtime/transcript', {
          conversationId: convoIdRef.current,
          userText: userTextRef.current,
          assistantText: assistantFinalText,
          userMessageId: uId,
          assistantMessageId: aId,
          userParentMessageId,
          assistantParentMessageId,
          parentMessageId: userParentMessageId,
          endpoint: endpoint ?? undefined,
          endpointType: endpointType ?? undefined,
          model: model ?? undefined,
          agentId: agentId ?? undefined,
          spec: spec ?? undefined,
        });
      } catch {
        /* best-effort; the DB reconcile on stop covers transient failures */
      }
    },
    [endpoint, endpointType, model, agentId, spec],
  );

  const handleUserTranscript = useCallback(
    (transcript: string) => {
      const text = (transcript || '').trim();
      if (!text) {
        return;
      }
      const id = genId();
      userIdRef.current = id;
      userParentRef.current = lastIdRef.current;
      userTextRef.current = text;
      lastIdRef.current = id;
      setUserCaption(text);
      setAssistantCaption('');
      upsertTurn(
        makeMessage({ messageId: id, parentMessageId: userParentRef.current, text, isCreatedByUser: true }),
      );
    },
    [makeMessage, upsertTurn],
  );

  const handleAssistantDelta = useCallback(
    (delta: string) => {
      if (!delta) {
        return;
      }
      setStatus('speaking');
      if (!assistantIdRef.current) {
        assistantIdRef.current = genId();
        assistantTextRef.current = '';
        // assistant turn is a child of the user turn (or the prior chain head)
        const parent = userIdRef.current ?? lastIdRef.current;
        lastIdRef.current = assistantIdRef.current;
        upsertTurn(
          makeMessage({
            messageId: assistantIdRef.current,
            parentMessageId: parent,
            text: '',
            isCreatedByUser: false,
            unfinished: true,
          }),
        );
      }
      assistantTextRef.current += delta;
      setAssistantCaption(assistantTextRef.current);
      upsertTurn(
        makeMessage({
          messageId: assistantIdRef.current,
          parentMessageId: userIdRef.current ?? Constants.NO_PARENT,
          text: assistantTextRef.current,
          isCreatedByUser: false,
          unfinished: true,
        }),
      );
    },
    [makeMessage, upsertTurn],
  );

  const handleAssistantDone = useCallback(
    (transcript: string) => {
      const finalText = (transcript || assistantTextRef.current || '').trim();
      if (assistantIdRef.current) {
        upsertTurn(
          makeMessage({
            messageId: assistantIdRef.current,
            parentMessageId: userIdRef.current ?? Constants.NO_PARENT,
            text: finalText,
            isCreatedByUser: false,
            unfinished: false,
          }),
        );
      }
      void persistTurn(finalText);
      // reset for the next turn
      userIdRef.current = null;
      userTextRef.current = '';
      assistantIdRef.current = null;
      assistantTextRef.current = '';
      setStatus('listening');
    },
    [makeMessage, upsertTurn, persistTurn],
  );

  // Relay a realtime function call to the in-cluster MCP bridge
  // (POST /api/realtime/tool, authed), then return the result over the data
  // channel and ask the model to continue once all in-flight calls are done.
  const maybeRunTool = useCallback(async (callId?: string, name?: string, rawArgs?: any) => {
    if (!callId || !name || toolHandledRef.current.has(callId)) {
      return;
    }
    toolHandledRef.current.add(callId);
    pendingToolRef.current += 1;
    let args: any = {};
    if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs;
    } else if (typeof rawArgs === 'string') {
      try {
        args = rawArgs ? JSON.parse(rawArgs) : {};
      } catch {
        args = {};
      }
    }
    let output = '';
    try {
      const res = (await request.post('/api/realtime/tool', { name, arguments: args })) as {
        output?: string;
      };
      output = res?.output || '';
    } catch {
      output = 'That tool is unavailable right now.';
    }
    const dc = dcRef.current;
    if (dc && dc.readyState === 'open') {
      dc.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: callId, output },
        }),
      );
    }
    pendingToolRef.current -= 1;
    if (pendingToolRef.current <= 0 && dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'response.create' }));
    }
  }, []);

  const onDataChannelMessage = useCallback(
    (event: MessageEvent) => {
      let data: any;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (data.type) {
        case 'input_audio_buffer.speech_started':
          setStatus('listening');
          break;
        case 'conversation.item.input_audio_transcription.completed':
          handleUserTranscript(data.transcript || '');
          break;
        case 'response.output_audio_transcript.delta':
          handleAssistantDelta(data.delta || '');
          break;
        case 'response.output_audio_transcript.done':
          handleAssistantDone(data.transcript || '');
          break;
        case 'response.output_item.added':
        case 'response.output_item.done':
          if (data.item && data.item.type === 'function_call') {
            if (data.item.call_id && data.item.name) {
              toolNamesRef.current[data.item.call_id] = data.item.name;
            }
            // .done carries the fully assembled arguments string.
            if (data.type === 'response.output_item.done') {
              void maybeRunTool(data.item.call_id, data.item.name, data.item.arguments);
            }
          }
          break;
        case 'response.function_call_arguments.done':
          void maybeRunTool(
            data.call_id,
            data.name || toolNamesRef.current[data.call_id],
            data.arguments,
          );
          break;
        case 'error':
          onError?.(data.error?.message || 'Realtime error');
          break;
        default:
          break;
      }
    },
    [handleUserTranscript, handleAssistantDelta, handleAssistantDone, maybeRunTool, onError],
  );

  const stop = useCallback(() => {
    try {
      dcRef.current?.close();
    } catch {
      /* noop */
    }
    try {
      pcRef.current?.close();
    } catch {
      /* noop */
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
    }
    dcRef.current = null;
    pcRef.current = null;
    streamRef.current = null;
    setStatus('idle');
    setUserCaption('');
    setAssistantCaption('');
    // Reconcile the thread with the database (authoritative) once we stop.
    if (convoIdRef.current) {
      queryClient.invalidateQueries([QueryKeys.messages, convoIdRef.current]);
    }
  }, [queryClient]);

  const start = useCallback(async () => {
    if (status !== 'idle') {
      return;
    }
    setStatus('connecting');
    try {
      const session = (await request.post('/api/realtime/session', {
        // Continue the OPEN conversation: tell the server which thread to load as
        // context (omit for a brand-new chat so it starts fresh).
        conversationId:
          conversationId && conversationId !== Constants.NEW_CONVO ? conversationId : undefined,
      })) as SessionResponse;
      if (!session?.token || !session?.webrtcUrl) {
        throw new Error('No realtime session token');
      }

      // Fix the persistence target + thread base for this session.
      convoIdRef.current =
        conversationId && conversationId !== Constants.NEW_CONVO ? conversationId : genId();
      baseMessagesRef.current = (getMessages() || []).slice();
      turnsRef.current = [];
      toolHandledRef.current.clear();
      toolNamesRef.current = {};
      pendingToolRef.current = 0;
      lastIdRef.current = baseMessagesRef.current.length
        ? baseMessagesRef.current[baseMessagesRef.current.length - 1].messageId
        : Constants.NO_PARENT;
      // The persisted chain starts from the last existing message (so voice
      // turns append after prior history) or the root for a fresh chat.
      chainHeadRef.current = lastIdRef.current;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      if (!audioElRef.current) {
        const el = document.createElement('audio');
        el.autoplay = true;
        audioElRef.current = el;
      }
      pc.ontrack = (e) => {
        if (audioElRef.current && e.streams[0]) {
          audioElRef.current.srcObject = e.streams[0];
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const dc = pc.createDataChannel('realtime-channel');
      dcRef.current = dc;
      dc.onmessage = onDataChannelMessage;
      dc.onopen = () => setStatus('listening');

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // webrtcfilter=on keeps the system prompt private but DROPS the
      // function-call events; when tools are advertised the server returns
      // filterEvents:false so we receive them. Default (undefined) => no filter.
      const callsUrl =
        session.filterEvents === true
          ? `${session.webrtcUrl}?webrtcfilter=on`
          : session.webrtcUrl;
      const sdpResponse = await fetch(callsUrl, {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${session.token}`,
          'Content-Type': 'application/sdp',
        },
      });
      if (!sdpResponse.ok) {
        throw new Error(`SDP exchange failed: ${sdpResponse.status}`);
      }
      const answer = { type: 'answer' as RTCSdpType, sdp: await sdpResponse.text() };
      await pc.setRemoteDescription(answer);
    } catch (err: any) {
      onError?.(err?.message || 'Failed to start voice session');
      stop();
      setStatus('error');
    }
  }, [status, conversationId, getMessages, onDataChannelMessage, onError, stop]);

  return { status, userCaption, assistantCaption, start, stop };
}
