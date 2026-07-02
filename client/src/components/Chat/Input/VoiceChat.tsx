import { useEffect, useState } from 'react';
import { TooltipAnchor, useToastContext } from '@librechat/client';
import { request } from 'librechat-data-provider';
import { useChatContext } from '~/Providers';
import useRealtimeVoice, { type RealtimeStatus } from '~/hooks/Realtime/useRealtimeVoice';
import { cn } from '~/utils';

/**
 * VoiceChat — entry point for client-orchestrated WebRTC realtime voice.
 *
 * Renders a mic-wave trigger button in the chat input. When started it opens a
 * ChatGPT-style overlay (animated orb + live captions) while `useRealtimeVoice`
 * streams audio P2P to Azure and writes each completed turn into the active
 * conversation. The button hides itself entirely if the server reports realtime
 * voice is not configured (`GET /api/realtime/config`).
 */

function VoiceWaveIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Apple `waveform` idiom — live audio, deliberately NOT a microphone (the
          mic glyph belongs to dictation / AudioRecorder). Symmetric bars, tallest
          in the center, so it never reads as a second dictation button. */}
      <line x1="4" y1="9" x2="4" y2="15" />
      <line x1="8" y1="6" x2="8" y2="18" />
      <line x1="12" y1="3" x2="12" y2="21" />
      <line x1="16" y1="6" x2="16" y2="18" />
      <line x1="20" y1="9" x2="20" y2="15" />
    </svg>
  );
}

function statusLabel(status: RealtimeStatus): string {
  switch (status) {
    case 'connecting':
      return 'Connecting…';
    case 'listening':
      return 'Listening…';
    case 'speaking':
      return 'Speaking…';
    case 'error':
      return 'Connection error';
    default:
      return 'Tap to start';
  }
}

function VoiceOverlay({
  status,
  userCaption,
  assistantCaption,
  onClose,
}: {
  status: RealtimeStatus;
  userCaption: string;
  assistantCaption: string;
  onClose: () => void;
}) {
  const active = status === 'listening' || status === 'speaking' || status === 'connecting';
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Voice chat"
    >
      <div className="relative flex flex-col items-center gap-8 px-6 text-center">
        {/* Animated orb */}
        <div className="relative flex size-44 items-center justify-center">
          <span
            className={cn(
              'absolute inset-0 rounded-full opacity-60',
              status === 'speaking' ? 'bg-blue-500' : 'bg-emerald-500',
              active ? 'animate-ping' : '',
            )}
          />
          <span
            className={cn(
              'absolute inset-4 rounded-full opacity-80 transition-colors',
              status === 'speaking' ? 'bg-blue-500' : 'bg-emerald-500',
            )}
          />
          <span className="absolute inset-8 rounded-full bg-surface-primary" />
          <VoiceWaveIcon className="relative size-12 text-text-primary" />
        </div>

        <div className="text-sm font-medium text-white/80">{statusLabel(status)}</div>

        {/* Live captions (ChatGPT-style). Persisted turns also land in the thread. */}
        <div className="min-h-[3rem] max-w-xl space-y-2">
          {userCaption ? (
            <p className="text-base text-white/70">
              <span className="font-semibold">You: </span>
              {userCaption}
            </p>
          ) : null}
          {assistantCaption ? (
            <p className="text-lg text-white">{assistantCaption}</p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-4 rounded-full bg-red-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-red-700"
        >
          End voice chat
        </button>
      </div>
    </div>
  );
}

export default function VoiceChat({ disabled }: { disabled?: boolean }) {
  const { showToast } = useToastContext();
  const { conversation, getMessages, setMessages } = useChatContext();
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    request
      .get('/api/realtime/config')
      .then((cfg: any) => {
        if (mounted) {
          setEnabled(Boolean(cfg?.enabled));
        }
      })
      .catch(() => {
        /* feature simply stays hidden if the probe fails */
      });
    return () => {
      mounted = false;
    };
  }, []);

  const { status, userCaption, assistantCaption, start, stop } = useRealtimeVoice({
    conversationId: conversation?.conversationId,
    endpoint: conversation?.endpoint,
    endpointType: conversation?.endpointType,
    model: conversation?.model,
    agentId: (conversation as { agent_id?: string } | null)?.agent_id,
    spec: conversation?.spec,
    getMessages,
    setMessages,
    onError: (message) => showToast({ message, status: 'error' }),
  });

  if (!enabled) {
    return null;
  }

  const handleClose = () => {
    stop();
    setOpen(false);
  };

  const handleToggle = async () => {
    if (open) {
      handleClose();
      return;
    }
    setOpen(true);
    await start();
  };

  return (
    <>
      <TooltipAnchor
        description="Voice chat"
        render={
          <button
            type="button"
            aria-label="Voice chat"
            disabled={disabled}
            onClick={handleToggle}
            className={cn(
              'flex size-9 items-center justify-center rounded-full p-1 transition-colors hover:bg-surface-hover',
            )}
            title="Voice chat"
          >
            {/* Accent color distinguishes the live-voice affordance from the
                neutral dictation mic sitting next to it. */}
            <VoiceWaveIcon className="text-blue-500" />
          </button>
        }
      />
      {open ? (
        <VoiceOverlay
          status={status}
          userCaption={userCaption}
          assistantCaption={assistantCaption}
          onClose={handleClose}
        />
      ) : null}
    </>
  );
}
