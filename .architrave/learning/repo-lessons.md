# Repo lessons — LibreChat fork (realtime voice)

_Candidate lessons with evidence for the Architrave learning loop. Promote a lesson into
`architrave.config.json` / `AGENTS.md` / `.github/instructions` only after it recurs
(`promoteAfterOccurrences: 2`) and is validated against the current branch._

## L1 — the vite build does NOT typecheck
`client` builds with `vite build` (esbuild), which only fails on syntax / unresolved imports;
type errors slip through. **Always run `npm --prefix client run typecheck` before shipping** a fork
change (now folded into the Architrave `build` gate).
Evidence: `client/package.json` (`build` vs `typecheck`); homelab `librechat-voice` skill note.

## L2 — assign a strict linear parent chain at PERSIST time, never at event time
Synthesizing a LibreChat thread from out-of-order realtime events and computing `parentMessageId`
at event time created a **cycle** in the message tree → the whole conversation threw "Something went
wrong" on the next typed turn (with no server log). Fix: one monotonic `chainHeadRef` advanced only
at persist time; send explicit user/assistant parents.
Evidence: fork commit `48ce911c` (rt7).

## L3 — never write a non-chat model id onto a voice conversation
Attributing voice turns with the realtime **speech** deployment (`gpt-realtime-1-5`) or an empty
`agents` endpoint made the next **typed** turn fail to route. Attribute voice turns to a routable
chat endpoint+model (fallback `REALTIME_CHAT_ENDPOINT` / `_MODEL`).
Evidence: fork commits `4b2ce12d` (rt5), `b6ac0e2a` (rt6).

## L4 — sanitize tool schemas for Azure realtime
Azure realtime's function-tool validator **rejects** `anyOf`/`oneOf`/`allOf` and
`additionalProperties:true` (Pydantic/FastAPI emit exactly that) → HTTP 500 on session mint.
Collapse to a plain JSON-schema object before advertising the tool.
Evidence: fork commit `f03114c3` (rt8).

## L5 — the realtime "VoiceWaveIcon" actually draws a microphone
`VoiceChat.tsx`'s `VoiceWaveIcon` renders a **mic** (capsule + arc + base line), identical to the
native `AudioRecorder` dictation mic → two ambiguous side-by-side mics in the composer. Distinguish
the **live-voice** affordance (waveform glyph + accent color + spacing) from **dictation** (neutral
mic), per Apple HIG (mic = dictation, waveform = live audio).
Evidence: this session's UI review (2026-07-02); user screenshot of the composer.
