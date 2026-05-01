# Automated Testing Guide

Use this document to understand what the automated tests currently protect and where to add coverage after larger changes.

## Test Commands

- `npm test` runs the Vitest suite.
- `npm run build` runs TypeScript checking and the production Vite build.

Run both after changes that touch simulation, input, rendering contracts, networking, Firebase lobby data, or build configuration.

## Current Coverage

### Input

File: `src/input.test.ts`

Protects gamepad mapping into deterministic `InputBits`.

- Left stick maps to turn/thrust.
- Face and shoulder buttons map to primary/secondary fire.
- D-pad buttons work as movement alternates.

Add tests here when changing keyboard/gamepad bindings, dead zones, or input bit definitions.

### Deterministic Simulation

Files:

- `src/sim/fixed.test.ts`
- `src/sim/replay.test.ts`
- `src/sim/step.test.ts`

Protects deterministic game math and match outcomes.

- Fixed-point conversion and arithmetic are stable.
- Replaying the same initial state and inputs produces identical hashes.
- Sudden-death projectile hits end the match with the shooter as winner.
- Misses do not end the match.
- Projectiles cannot hit their owner.
- Once the match has a winner, movement, firing, and winner changes are frozen.

Add tests here when changing physics, movement, projectile behavior, collision, match-end rules, hashing, or any state used by rollback.

### Network Protocol

File: `src/net/protocol.test.ts`

Protects binary gameplay packet compatibility.

- Input, state hash, session config, ready, and ready-ack packets round-trip.
- Input resend windows are capped to the encoded limit.
- Malformed readiness packets are rejected.
- Unknown protocol versions and packet types are rejected.

Add tests here before changing packet layout, protocol versioning, field widths, or validation behavior.

### Rollback

File: `src/net/rollback.test.ts`

Protects prediction, rewind, replay, and desync reporting.

- Incorrect predicted remote input rewinds and replays to the canonical state.
- Rollback is reported on the next step after correction.
- Joiner-local input is routed as player two.
- Remote hash disagreement records a desync report.

Add tests here when changing prediction policy, history pruning, rollback limits, player index routing, or hash comparison.

### Network Match Session

File: `src/net/matchSession.test.ts`

Protects the high-level host/joiner gameplay session.

- Host emits session config and resends it until readiness arrives.
- Host and joiner complete config, ready, and ready-ack handshaking before stepping.
- Remote input packets route into rollback for the opposite player.
- State hash packets record desyncs.
- Status diagnostics report packet counts, input frames, hash frames, remote input age, rollback count, protocol errors, and session errors.
- Delayed, duplicated, and out-of-order gameplay packets remain deterministic.
- A dropped input packet can be recovered from the resend window.
- Invalid, early, duplicate, and stale packets are handled without crashing.

Add tests here when changing handshake behavior, input resend policy, diagnostics, packet ordering assumptions, or session readiness.

### Peer Status Formatting

File: `src/net/peerStatus.test.ts`

Protects the detailed network status string shown in the UI.

- Closed and failed peer states display when no match diagnostics exist.
- Readiness, packet counts, input age, rollback, hash, protocol, and session status are included when diagnostics exist.

Add tests here when changing the peer status display contract.

## Coverage Gaps

These areas are not yet covered by automated tests:

- `src/net/webrtc.ts`: browser `RTCPeerConnection` behavior, data channel lifecycle, and ICE candidate timing.
- `src/net/lobby.ts`: Firebase Realtime Database reads/writes, lobby claiming, and candidate storage.
- `database.rules.json`: Firebase rules validation.
- `src/main.ts`: DOM wiring, lobby UI, and match/peer status integration.
- `src/render/canvasRenderer.ts`: canvas drawing behavior.

For now, changes in these areas should be paired with focused tests where practical and verified with the manual Firebase/WebRTC checklist. If we add Firebase emulator tooling or browser integration tests, these gaps should be the first targets.

## When To Add Tests

Add or update automated tests when a change affects:

- Any deterministic state field in `GameState`.
- `hashState`, `stepGame`, fixed-point math, or replay behavior.
- Binary packet encoding or decoding.
- Rollback prediction, recovery, or history pruning.
- Network match handshake, resend windows, packet ordering, or diagnostics.
- Input mappings or `InputBits`.
- User-visible status formatting that other debugging steps depend on.

Prefer small tests that lock down one invariant at a time. For network and simulation work, compare hashes or final state instead of relying on visual behavior.
