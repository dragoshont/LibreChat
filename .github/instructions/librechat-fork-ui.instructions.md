---
description: LibreChat fork (feat/realtime-voice) client UI + fork discipline. Reuse existing components + semantic Tailwind tokens; the fork is additive; there is no Storybook.
applyTo: 'client/src/**'
---

# LibreChat fork — client UI conventions

This is a **fork** of upstream LibreChat `v0.8.0` (`dragoshont/LibreChat`, branch
`feat/realtime-voice`) that adds WebRTC realtime voice. Keep changes **additive** so an upstream
rebase stays a simple replay.

## Ground in what exists (reproduce, don't reinvent)
- There is **no Storybook** for our components. Reproduce existing components from
  `client/src/components` and `packages/client`; specify only the deltas.
- Use LibreChat's **semantic Tailwind tokens** — `text-text-primary` / `text-text-secondary`,
  `bg-surface-primary` / `bg-surface-hover`, `border-border-*`, etc. **Never hard-code** a hex
  color, px size, or radius that an existing class/token already owns.
- Match the sibling composer controls (`AudioRecorder`, attach, send) for size / hover / tooltip.

## Realtime voice surface
- Lives in `client/src/hooks/Realtime/useRealtimeVoice.ts` (WebRTC + event→thread mapping +
  persistence) and `client/src/components/Chat/Input/VoiceChat.tsx` (button + overlay), mounted in
  `client/src/components/Chat/Input/ChatForm.tsx`.
- **Distinguish live voice from dictation.** The realtime button is a **waveform** with an accent
  color; the native `AudioRecorder` is a neutral **microphone** (dictation). Two identical mics
  side-by-side is ambiguous — see `.architrave/learning/repo-lessons.md` L5.
- The **persistence / message-tree** code is fragile (repo-lessons L2 / L3). Do not compute message
  parents at event time; do not write a non-chat model id onto a voice conversation.

## Before shipping a fork change
- Run `npm --prefix client run typecheck` — **the vite build does not typecheck** (repo-lessons L1).
- Preview by running the client (`npm run frontend:dev`) or a Playwright screenshot of the running
  app; there is no Storybook preview step.
- The image is built on the homelab **host** and deployed via homelab GitOps — not from this repo.
  Never commit secrets (the Azure key + prompts are env-injected from homelab).
