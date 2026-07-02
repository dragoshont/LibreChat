# Repo profile — LibreChat fork (realtime voice)

_Concise, cited description for the Architrave learning loop. Last review: 2026-07-02._

## Purpose
Fork of **LibreChat `v0.8.0`** (`danny-avila/LibreChat`, upstream tag `b7d13cec`) that adds
**client-orchestrated WebRTC realtime voice** to `chat.hont.ro`: ChatGPT-style speech-to-speech
where both transcripts land in the LibreChat thread and persist, with RM MCP tools + per-user
memory over voice. Fork: `dragoshont/LibreChat`, branch **`feat/realtime-voice`**. Purely
**additive** over upstream — an upstream rebase is a replay of the realtime commits.

## Surfaces / lanes
- **Web UI (primary)** — React + Vite + Tailwind under `client/src/**`. **No Storybook** for our
  components; ground in existing components (`client/src/components`, `packages/client`) +
  LibreChat's semantic Tailwind tokens + the `web` knowledge pack.
- **Node backend** — `api/server/routes/realtime.js` (`/config`, `/session`, `/tool`,
  `/transcript`), behind `requireJwtAuth`. Scope `api/**`, `packages/**`.
- **No IaC / no ops lane in the fork** — the image is built on the homelab **host**
  (`localhost:32000/librechat-voice:v0.8.0-rtN`) and deployed via **homelab GitOps**
  (`apps/platform/librechat/deployment.yaml`), not from this repo.

## Source of truth (the realtime patch)
- Server `api/server/routes/realtime.js` — `/config`; `/session` mints the ephemeral Azure token
  and injects user memories + the open conversation's history into the voice instructions; `/tool`
  relays MCP/memory/web-search calls; `/transcript` persists turns, scoped to `req.user.id`.
- Client `client/src/hooks/Realtime/useRealtimeVoice.ts` (RTCPeerConnection + event→thread mapping
  + persistence) and `client/src/components/Chat/Input/VoiceChat.tsx` (trigger button + overlay),
  mounted in `client/src/components/Chat/Input/ChatForm.tsx` next to `AudioRecorder`.

## Build / test
- `npm run frontend` — builds the workspace packages + client vite bundle (the image path).
- `npm --prefix client run typecheck` — `tsc --noEmit`. **The vite build does NOT typecheck**, so
  this is the real type gate (folded into the Architrave `build` gate).
- `npm run test:client` / `npm run test:api` — jest.
- The image is built + pushed **on the host** (homelab `librechat-voice` skill), then deployed via
  homelab GitOps. Current live pin: `rt12`.

## Architecture (decision)
Client-orchestrated WebRTC (P2P audio browser↔Azure `gpt-realtime-1-5`) + **server-minted ephemeral
token** (the standing Azure key never leaves the server) + **dual persistence** (client renders live
via `setMessages`; server persists each turn scoped to `req.user.id`).

## Recurring gotchas (fixes in repo-lessons.md)
- The vite build **skips typecheck** — always run `typecheck` before shipping (L1).
- The **persistence / message-tree** path is fragile (rt5–rt9: realtime-model leak, empty-`agents`
  endpoint, message-tree cycle) — do not compute message parents at event time; do not write a
  non-chat model id onto a voice conversation (L2, L3).
- Azure realtime rejects `anyOf`/`additionalProperties:true` in tool schemas — sanitize (L4).
- The fork is **public** — no secrets in code (Azure key + the family prompt are env-injected from
  homelab).
