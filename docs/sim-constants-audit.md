# Simulation Constants Audit

This audit covers only authoritative simulation code under `src/sim`. It records where the current numbers come from, whether they are still unexplained inline values, and what should happen in a later cleanup pass. It does not recommend retuning behavior in this pass.

## Summary

Most frame-to-frame physics tuning is already named at the top of `src/sim/step.ts`. The remaining cleanup is mostly about making the reference-backed world setup in `src/sim/state.ts` explicit, removing a few inline derived values, and documenting intentional current-game tuning that differs from the old C++ implementation.

The old game anchors are:

- `reference_code/Board.cpp`: arena radius `1450`, planet radius `80`, gravity strength `1000`, minimum gravity distance squared `2500`, wrap bounds at `+/-mArenaRadius`.
- `reference_code/Player.cpp`: base max speed `3`, scaled active max speed `1.55`, thrust cap curve `0.06 + 0.94 * availableSpeed`, over-max damping `0.98`, top-speed allowance `2`, spawn offset `0.85 * 500`, primary shot speed `15`, primary shot cadence `6`, player radius `55`.

## Recommended Cleanup Order

1. Extract reference-backed world setup constants from `src/sim/state.ts`.
2. Extract or derive the remaining inline sim values in `src/sim/step.ts` and `src/sim/trig.ts`.
3. Add short comments for current-game tuning that intentionally differs from the reference.
4. Leave protocol/hash/test scaffolding numbers alone unless they obscure a test's intent.

## `src/sim/state.ts`

| Value | Current use | Source | Recommendation |
| --- | --- | --- | --- |
| `0x5eed_2026` | Default seed for `createInitialState` | Current deterministic seed, not from the C++ reference | Extract as `DEFAULT_SIM_SEED`. Consider sharing with net match setup in a separate pass if net code remains in scope. |
| `2900` | Square arena width and height | Derived from `Board.cpp` `mArenaRadius = 1450` and wrap range `2 * mArenaRadius` | Extract `LEGACY_ARENA_RADIUS = fixedFromInt(1450)` and derive arena size from it, or extract `LEGACY_ARENA_SIZE = fixedFromInt(2900)` with a source comment. |
| `0`, `0` | Planet origin | Reference planet is reset to origin in `Board.cpp` gravity/update setup | Leave as explicit origin or name `PLANET_CENTER_X/Y` if extracting all world defaults together. |
| `80` | Planet radius | `Board.cpp` `mPlanet->mRadius = M(80)` | Extract `LEGACY_PLANET_RADIUS`. |
| `425`, `-425` | Initial ship positions | Derived from `Player.cpp` `0.85 * 500`; the reference also adds random `+/-50` jitter | Extract `LEGACY_SPAWN_OFFSET = fixedFromInt(425)` and comment that the TS sim intentionally omits reference spawn jitter for determinism. |
| `angle(0)` | Player 1 heading | Deterministic replacement for reference randomized heading near zero | Leave, with spawn constants if grouped. |
| `angle(128)` | Player 2 heading | Half-turn in the current `ANGLE_STEPS = 256` system; corresponds to roughly `pi` | Derive from `ANGLE_STEPS / 2` if exporting a helper is acceptable, or name `OPPOSING_SHIP_ANGLE`. |
| Ship ids `0`, `1` | Player identifiers | Structural two-player sim convention | Leave inline unless a central player-id enum is introduced. |
| `primaryCooldown: 0` | Initial weapon readiness | Structural initial state | Leave inline. |
| `nextProjectileId: 1` | First generated projectile id | Current id convention; test helpers assume generated ids start after zero | Extract only if projectile id allocation gets centralized. |

## `src/sim/step.ts`

### Already Named

| Constant | Current value | Source | Recommendation |
| --- | --- | --- | --- |
| `THRUST` | `0.08` | Current-game tuning. Reference effective thrust is `mAccel 0.02 * 1.35 = 0.027` before coordinate-system differences. | Keep named. Add a source/tuning comment before retuning decisions. |
| `TURN_STEP` | `2` of `256` angle steps | Current-game tuning. Reference turn speed is `mTurnSpeed 0.015 * 1.6` radians/frame. | Keep named. If parity is revisited, compare angular velocity over frames. |
| `BASE_MAX_SPEED` | `4.65` | Reference `mMaxSpeed 3.0 * 1.55` | Keep named; add a short source comment. |
| `TOP_SPEED_ALLOWANCE` | `2` | Reference `aTopMax = 2.0 + aMaxSpeed` | Keep named; add a short source comment. |
| `CLOSE_PLANET_SPEED_BOOST` | `350` | Current-game tuning. Reference uses `2000 / distance`. | Keep named but mark as a parity decision. |
| `GRAVITY_STRENGTH` | `1000` | Reference `-1000 / aMag2` gravity term | Keep named; add a source comment. |
| `MIN_GRAVITY_DISTANCE` | `50` | Derived from reference clamp `aMag2 < 2500` | Keep named; add a source comment that it is the square-root of the reference clamp. |
| `THRUST_CAP_MIN` | `0.06` | Reference thrust cap curve | Keep named; add a source comment. |
| `THRUST_CAP_RANGE` | `0.94` | Reference thrust cap curve | Keep named; add a source comment. |
| `THRUST_CAP_MAX` | `1.8` | Current clamp ceiling; related to reference speed-preserve multiplier but not the same expression | Keep named. Verify whether this is a real gameplay cap or defensive clamp before changing. |
| `OVER_MAX_THRUST_DAMPING` | `0.98` | Reference over-max damping while thrusting | Keep named; add a source comment. |
| `GRAVITY_SPEED_PRESERVE_MULTIPLIER` | `1.8` | Reference gravity preserve threshold uses `1.8 * mMaxSpeed`; TS uses scaled `BASE_MAX_SPEED` | Keep named but mark as a parity decision because the base differs. |
| `PROJECTILE_SPEED` | `6.5` | Current-game tuning. Reference primary shot speed is `15`. | Keep named and mark as parity decision. |
| `PROJECTILE_TTL` | `90` | Current-game tuning; reference lifetime is not represented as a simple matching value here | Keep named. |
| `FIRE_COOLDOWN_FRAMES` | `18` | Current-game tuning. Reference primary cadence is `6` frames. | Keep named and mark as parity decision. |
| `SHIP_COLLISION_RADIUS` | `22` | Current-game tuning. Reference player radius is `55` with scale `0.40`, which also evaluates to `22` for visible/collision scale. | Keep named; add source comment if this was intentionally derived from `55 * 0.40`. |
| `SHIP_HIT_RADIUS` | `SHIP_COLLISION_RADIUS` | Derived current rule | Leave as derived. |

### Remaining Inline Values

| Value | Current use | Source | Recommendation |
| --- | --- | --- | --- |
| `fixed(-0.5)` | Planet collision bounce reverses and halves ship velocity | No clear direct reference line found; reference planet object has `mBouncy = 0.92`, but collision response is not mapped one-to-one | Extract as `PLANET_COLLISION_BOUNCE = fixed(-0.5)` and mark as current simplification. Do not retune without collision parity work. |
| `max / 2` | `wrapSignedFixed` derives signed wrap radius from arena size | Derived from reference bounds `+/-mArenaRadius` | Leave as derived or rename local `radius` to `halfExtent`. No gameplay retune needed. |
| `fixed(-1)` | Gravity direction toward planet | Algorithmic sign | Leave inline or replace with a named `NEGATE` only if nearby fixed-point helpers already use one. |
| `0` and `1` checks/increments | Frame advance, cooldown decrement, alive tests, empty input defaults | Structural algorithm values | Leave inline. |

## `src/sim/trig.ts`

| Value | Current use | Source | Recommendation |
| --- | --- | --- | --- |
| `ANGLE_STEPS = 256` | Discrete angle space | Current deterministic sim representation, not directly from reference | Keep exported and named. |
| `ANGLE_MASK = ANGLE_STEPS - 1` | Fast angle wrapping | Derived | Leave. |
| `65536` | Trig LUT fixed-point scale | Same value as `FIXED_ONE` from `src/sim/fixed.ts` | Replace with `FIXED_ONE` import or a local `FIXED_TRIG_SCALE` derived from it. This is cleanup only and should preserve LUT values. |
| `2` in `Math.PI * 2` | Full turn in radians | Mathematical constant | Leave inline. |

## `src/sim/types.ts`

| Value | Current use | Source | Recommendation |
| --- | --- | --- | --- |
| `PLAYER_COUNT = 2` | Two-player sim | Game rule | Already named; leave. |
| Input bit shifts `1 << 0` through `1 << 4` | Input wire/state representation | Bitmask layout | Leave inline in enum. These are protocol-like representation values, not tuning. |

## `src/sim/rng.ts`

| Value | Current use | Source | Recommendation |
| --- | --- | --- | --- |
| Xorshift shifts `13`, `17`, `5` | RNG algorithm | Xorshift32 constants | Leave inline or comment as xorshift32. Not game feel while RNG is only advanced deterministically. |
| `0x1_0000_0000` | Convert uint32 to `[0, 1)` | Derived from `2^32` | Leave inline or name `UINT32_RANGE` for clarity. |

## `src/sim/hash.ts`

| Value | Current use | Source | Recommendation |
| --- | --- | --- | --- |
| `0x811c_9dc5`, `0x0100_0193` | FNV-1a hash seed and prime | Hash algorithm | Leave inline with a short FNV-1a comment if desired. Not gameplay tuning. |
| `0xffff_ffff` | Null winner sentinel in hash stream | Hash representation | Leave inline or name `NULL_WINNER_HASH_VALUE`. |
| `4`, `0xff`, `8` | Mix 32-bit values one byte at a time | Hash algorithm | Leave inline. |

## `src/sim/step.test.ts`

The test file repeats production constants to assert current behavior. That is useful for catching accidental changes, but some helper-only values can be named:

| Value | Current use | Recommendation |
| --- | --- | --- |
| `123`, `1234` | Deterministic test seeds | Leave inline unless tests start sharing a fixture seed. |
| `2900`, `80`, `425`, `2` | Expected arena, planet, spawn, turn behavior | Keep as explicit expectations. Once production constants are exported, consider importing only if the test is meant to check wiring rather than lock behavior. |
| `1449`, `1440` | Boundary wrap setup/assertions | Leave; these describe the edge-case scenario. |
| `200`, `400`, `3`, `120`, `60` | Physics scenario setup/assertions | Leave or name locally if additional gravity tests are added. |
| `99`, `100`, `10` | Test projectile id, next id, and TTL scaffolding | Name as local helper constants if the helpers grow; otherwise acceptable. |

## Later Parity Decisions

These are behavior choices that should not be changed as part of magic-number cleanup:

- `THRUST = 0.08` versus reference effective `0.027`.
- `TURN_STEP = 2 / 256 turn` versus reference `0.024` radians/frame.
- `CLOSE_PLANET_SPEED_BOOST = 350` versus reference `2000 / distance`.
- Gravity preserve threshold using `BASE_MAX_SPEED * 1.8` versus reference `mMaxSpeed * 1.8`.
- `PROJECTILE_SPEED = 6.5` and `FIRE_COOLDOWN_FRAMES = 18` versus reference primary `15` speed and `6` frame cadence.
- Deterministic spawn positions and headings versus reference spawn jitter and randomized starting angles.

## Proposed Follow-Up Patch

For a behavior-preserving cleanup, extract or document only these items:

- In `src/sim/state.ts`, introduce named world defaults for seed, arena size/radius, planet radius, spawn offset, opposing heading, and first projectile id.
- In `src/sim/step.ts`, introduce `PLANET_COLLISION_BOUNCE` and add source comments to reference-backed constants.
- In `src/sim/trig.ts`, replace the LUT `65536` literal with `FIXED_ONE`.
- Optionally name projectile helper constants in `src/sim/step.test.ts` if test readability is part of the cleanup pass.

