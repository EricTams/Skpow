# Star Control 2 Melee Web Port — Technical Design

A working document covering the technical decisions for porting an old Star Control 2 Hyper Melee homage to the modern web as a real-time, peer-to-peer two-player game.

## Goals and Constraints

The game has to feel responsive locally — that's the whole experience. The original was a fast, twitchy duel of momentum and weapon timing, and any input lag will gut the feel. At the same time, we want true peer-to-peer networking (no game server to run or pay for), and we want pre-match fleet construction to be a meaningful part of the experience.

The simulation itself is small and well-understood: two ships, a handful of projectiles, a planet with gravity, occasional asteroids. State is tiny. This shapes most of the technical choices below — we can be more aggressive about techniques like rollback and full-state snapshots than a more complex game would tolerate.

The target stack is TypeScript end-to-end, running in modern browsers, with Firebase as the only backend dependency.

## Networking Model: Peer-to-Peer Over WebRTC

There is no game server. Two browsers talk directly to each other over WebRTC DataChannels for the duration of a match. A third party (Firebase) is used only for matchmaking and the initial WebRTC handshake; once peers are connected, the lobby entry is destroyed and Firebase is out of the picture.

This means no server costs, no server latency, and no central point of failure for live matches. It also means we have to handle NAT traversal, signaling, and connection establishment ourselves, and we have to accept that some pairs of players (those behind symmetric NATs) may not be able to connect without a TURN relay.

### Two DataChannels, Different Reliability

A single DataChannel can't serve both gameplay and control-plane traffic well. We'll open two:

A **gameplay channel** configured as unreliable and unordered (`ordered: false`, `maxRetransmits: 0`). This is what carries per-frame input packets. We don't want TCP-style head-of-line blocking on packet loss, and we don't care about retransmission because rollback handles missing inputs via prediction. The gameplay channel behaves like UDP.

A **control channel** configured as reliable and ordered (the default). This carries lobby messages, fleet selections, ready/lock-in signals, pause requests, rematch offers, and chat. These are infrequent, and we very much do care that they arrive in order and don't get dropped.

### Signaling Through Firebase

Firebase serves three purposes during matchmaking: a discoverable list of open lobbies, a place for the host and joiner to exchange WebRTC SDP offers and answers, and a place to exchange ICE candidates as they're discovered. Once the WebRTC connection is up, the lobby document is deleted.

The lobby document holds: host UID, lobby settings (point total, draft mode, any other knobs), the host's SDP offer, and an `expiresAt` timestamp. Subcollections hold the joiner's answer and ICE candidates from both sides.

Realtime Database is preferable to Firestore here specifically because of `onDisconnect()` handlers, which let us automatically clean up abandoned lobbies when a host's tab closes. Firestore lacks this and would require a TTL field plus a periodic Cloud Function for cleanup. For lobby data — small, ephemeral, presence-driven — RTDB is the better tool. (If we end up with other Firestore needs, we can mix the two.)

### NAT Traversal: STUN Now, TURN Later

We'll start with Google's free public STUN servers, which work for the majority of home networks. Some fraction of users — those behind symmetric NATs or restrictive corporate firewalls — won't be able to establish a direct peer connection and need a TURN relay server to bounce traffic through. TURN is bandwidth-intensive and therefore not free.

For a hobby launch, ship with STUN-only and tell users in the UI when a connection fails. If it becomes a real friction point, add a TURN provider (Metered.ca and Twilio both have reasonable free tiers; self-hosting coturn is also viable).

### Anonymous Auth

Firebase Anonymous Authentication gives every visitor a stable UID without a sign-up flow. This is enough to attach lobby ownership to a user and to enforce sane security rules (only the host can modify their own lobby document; only the joiner can write to their own answer subcollection). Optional account linking can come later if we want persistent stats or friend lists.

## Hiding Latency: Rollback Netcode

The crucial choice. With ~50–150ms of round-trip latency between peers, applying remote inputs only when they arrive would mean delaying every local input by the same amount — an unplayable 3–9 frames of input lag at 60Hz.

The alternative used by every modern fighting game and the right fit here is rollback. Each peer:

1. Applies its own input immediately, every frame.
2. Predicts the remote player's input (almost always: "same input as last frame").
3. Simulates forward using both real-local and predicted-remote inputs.
4. When the remote input actually arrives, compares against the prediction. If correct (the common case), nothing happens. If wrong, rolls the simulation back to the frame in question, replays forward with the corrected input, and continues.

The local player feels zero input latency, always. The remote ship occasionally pops to a slightly different position when prediction is wrong, but for ships with significant inertia and inputs that are usually held for stretches (thrust, turn), prediction is correct the large majority of frames and the visual artifacts are minor.

### Why Rollback Fits This Game

The simulation state is tiny — ship positions, velocities, headings, weapon cooldowns, projectile arrays, planet, RNG seed. Probably under a kilobyte serialized. We can copy the entire state in microseconds and re-simulate eight frames of physics in well under a millisecond. Rollback is essentially free, performance-wise.

Two players means we only ever need to predict one remote input stream. Rollback complexity scales poorly with player count, but at N=2 it's manageable.

The original SC2 melee already feels good with momentum-heavy ships. That same inertia is what makes input prediction reliable.

### Requirements Rollback Imposes

The simulation must be **deterministic**. Given the same starting state and the same input sequence, both peers must produce bit-identical results, frame after frame. Any divergence — even one bit — compounds catastrophically over a few seconds. This is the dominant engineering constraint on the rest of the design and is the reason for the fixed-point math choice in the next section.

The simulation must be a **pure step function**. Logically: `(state, inputsForThisFrame) → newState`. Rendering reads from the latest sim state but never mutates it. No clock dependencies inside the sim. No `Math.random()`; only a seeded PRNG whose seed is part of the state. No DOM access, no audio triggers reaching back into sim state.

The simulation must be **cheap to copy and re-run**. Plain TypeScript objects work, but we'll lean on `Int32Array` for hot state to make snapshotting and cloning fast.

### Protocol Sketch

Each frame at 60Hz, each peer sends a small packet on the gameplay channel containing: a frame number, the input bitmask for that frame (8 bits is plenty: thrust, turn left, turn right, primary fire, secondary fire, plus a couple of reserved bits), and the last few frames of inputs as redundancy in case of dropped packets. The payload is tiny — under 10 bytes per packet, ~600 bytes per second per direction.

Periodically (say, every 60 frames) each peer also sends a hash of the simulation state at a recent confirmed frame. If the hashes don't match, we have a desync — the game pauses and surfaces a diagnostic. In development this is the single most valuable debugging tool.

We cap rollback depth at something like 10 frames. If the remote input still hasn't arrived, the game stalls briefly rather than rolling back arbitrarily far. This bounds worst-case CPU and prevents pathological connection states.

## Determinism: Fixed-Point Math

JavaScript's `number` is a 64-bit float, and float math isn't bit-deterministic across CPUs and browsers. `Math.sin`, `Math.cos`, and even basic arithmetic in some edge cases can produce different results on different machines. For a rollback game, that's a non-starter.

We'll represent all simulation quantities as fixed-point integers — an integer with an implied decimal point at, say, bit 16. A position of "100.5 units" is stored as `100.5 * 65536 = 6586368`. All sim math is integer math, which is bit-deterministic everywhere. JavaScript's `number` can represent integers exactly up to 2^53, so we have huge headroom for a small play area.

### Trig via Lookup Tables

`Math.sin` and `Math.cos` are out. Instead, we precompute sin and cos for a power-of-two number of angle steps (1024 or 4096) into typed arrays of fixed-point integers. Ship rotation becomes an integer angle index, angle wraparound is a free bitmask, and the lookup is bit-identical on every machine. This is also closer in spirit to the original era of the game.

### Square Root

Avoidable in most cases — comparing squared distances is enough for collision and proximity checks. When we genuinely need a length (e.g., for a unit vector), an integer square root is straightforward to implement (~20 lines, deterministic).

### Branded Types in TypeScript

We'll use a branded type for fixed-point values so the compiler catches the bug where someone accidentally writes `position + 1` instead of `position + FIXED_ONE`:

```typescript
type Fixed = number & { readonly __brand: 'Fixed' };
```

This costs nothing at runtime and is a meaningful safety net.

### Desync Debugging

Even with fixed-point, we'll get desyncs during development from things like accidentally reading wall-clock time inside the sim, or iterating over a Map (insertion-order-dependent across engines), or any of a dozen subtler bugs. We need tooling from day one:

- A frame-by-frame state hash comparison so we can pinpoint the exact frame two peers diverged.
- A "record and replay" mode where we save a sequence of inputs and a starting state and can replay it deterministically.
- A "two browsers, same machine" test harness so we can iterate on netcode bugs without needing two computers.

## Architecture: Sim and Render Cleanly Separated

The simulation runs at a fixed 60Hz timestep, regardless of display rate, on its own logical clock. Rendering interpolates between simulation frames for smoothness on high-refresh displays.

```
┌─────────────────┐    inputs    ┌──────────────────┐
│  Input layer    │─────────────▶│ Simulation (60Hz)│
│ (keyboard/pad)  │              │   pure, fixed-pt │
└─────────────────┘              └────────┬─────────┘
                                          │ state snapshots
                                          ▼
                                 ┌──────────────────┐
                                 │ Renderer (vsync) │
                                 │ floats, canvas/  │
                                 │ webgl, audio     │
                                 └──────────────────┘
                                          ▲
                                 ┌────────┴─────────┐
                                 │ Network layer    │
                                 │ rollback,        │
                                 │ DataChannels     │
                                 └──────────────────┘
```

The simulation knows nothing about rendering, audio, the network, or the DOM. It exposes a `step(state, inputs) → state` function and a `hash(state) → number` function and that's essentially it. Everything else lives outside.

The renderer reads the most recent two sim states and interpolates by `(now - lastSimTime) / SIM_DT`. This gives smooth visuals on 120Hz and 144Hz displays without coupling render rate to simulation rate.

The network layer wraps the sim. It buffers local inputs, sends them on the gameplay channel, receives remote inputs, runs the rollback loop, and feeds the resulting state to the renderer.

## Lobby and Match Lifecycle

The user flow, end to end:

1. Player opens the site → anonymous auth happens silently → they see a list of open lobbies (live-updated from RTDB).
2. They either create a lobby (with point total and draft-mode settings) or join an existing one.
3. Hosting writes a lobby doc to RTDB with an `onDisconnect().remove()` so the entry self-destructs if the host vanishes.
4. The joiner clicks a lobby. WebRTC signaling happens through the lobby doc — offer, answer, ICE candidates flying back and forth. Typically completes in well under a second.
5. Once both DataChannels are open, the lobby doc is deleted. The two browsers no longer touch Firebase for this match.
6. Fleet selection happens over the control channel. Each player picks ships, the running point total updates live, both players hit "ready," and the match starts.
7. Match runs entirely peer-to-peer. Inputs stream over the gameplay channel; control messages (pause, etc.) over the control channel.
8. After the match: rematch offer over the control channel, or one or both players disconnect cleanly.

If the connection drops mid-match, we surface that to both players and offer to re-establish via a new signaling round through Firebase. We don't try to recover the in-progress match — too much state, too rare a case to be worth the complexity.

## Fleet Selection Phase

Fleet selection happens after the WebRTC connection is established, not before. We don't want either player to invest time picking ships only to find out the connection isn't viable. The lobby phase exists to confirm "we have a working low-latency channel"; the fleet-select phase is the first thing both players see once peered up.

Lobby settings (point total, draft rules) are decided by the host at lobby-creation time, written to the lobby doc, and visible to the joiner before they join. Once selection starts, rules don't change.

The selection phase uses the reliable+ordered control DataChannel — fleet picks are infrequent but must arrive intact and in order. Each pick/unpick is a small message; both clients maintain their view of both fleets and validate against the lobby rules.

If the connection drops during fleet selection, we fall back to the lobby state cleanly. State invested so far is small enough that re-doing it is fine.

## Open Questions and Future Work

Some things I'm deferring deliberately:

**Spectators.** Three or more peers in a mesh is a different networking problem and not interesting for v1. If we want spectator support later, the cleanest path is probably to have one of the players relay state to spectators on a separate channel.

**Cheating.** P2P games are inherently more vulnerable to cheating than server-authoritative ones — there's no neutral arbiter of state. For a hobby project among friends or small communities this is fine. If a competitive scene develops, we'd need to think about state-hash agreement, replay verification, or a server-authoritative mode.

**Mobile and touch.** The game is built around precise analog-feeling input. Touch controls are doable but a separate design problem.

**Persistent stats and accounts.** Anonymous auth is enough to get started. If we want leaderboards, ELO, friend lists, etc., we layer those on top later.

**Audio.** Mostly orthogonal to the netcode design — audio cues fire from the renderer based on state transitions in the sim, not from the sim itself.

## Summary of Key Decisions

The simulation is a pure, deterministic, fixed-point step function running at 60Hz, with state small enough to copy and rehash freely. Networking is true peer-to-peer over WebRTC, with two DataChannels (unreliable for gameplay inputs, reliable for control messages). Latency is hidden via rollback netcode with last-input prediction and a rollback cap of ~10 frames. Firebase Realtime Database serves only as a signaling and matchmaking layer, with `onDisconnect()` handling abandoned lobbies. Fleet selection happens post-connection over the reliable channel. Rendering is decoupled from simulation and interpolates between sim frames for smooth display on any refresh rate.

The dominant engineering risk is determinism — getting two browsers on different machines to produce bit-identical simulation results, frame after frame. Investing in desync diagnostics from day one is the single highest-leverage thing we can do to keep that risk manageable.
