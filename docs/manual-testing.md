# Manual Testing Checklist

Use this checklist after each small milestone before adding the next feature.

## Local Prototype

- Run `npm run dev` and open the local URL.
- Verify the arena appears with two colored ships, a yellow planet, and a dark background.
- Move player 1 with WASD or arrow keys and fire with Space.
- Move player 2 with I/J/L and fire with Enter.
- Connect a controller and press a button so the browser exposes it, then verify controller 1 appears in the input status line.
- Move player 1 with controller 1: left stick or d-pad turns, up/RT thrusts, A/RB fires primary, B/LB fires secondary.
- If a second controller is connected, verify controller 2 drives player 2 with the same mapping.
- Confirm ships wrap around arena edges and projectiles disappear after a short lifetime.
- Fire one ship into the other and confirm the hit ship loses immediately, the winner banner appears, and movement/firing stops affecting the match result.
- Confirm the frame counter and hash keep updating without visible stutters.

## Build and Tests

- Run `npm test`.
- Run `npm run build`.
- Confirm `dist/` is created and no files from `reference_code/` or `reference_art/` are copied into it.

## Firebase and WebRTC

- Copy `.env.example` to `.env.local` and fill in Firebase web app values.
- Run `npm run dev` in two browser tabs.
- Sign in anonymously in both tabs.
- Create a lobby in one tab and join it from the other tab.
- Confirm both tabs report a connected peer state.
- Send a control ping and confirm the other tab logs the message.
- Confirm the lobby disappears after the peer connection opens.
- Confirm the peer summary reports `connected`, then `ready`, and that the detailed status shows packet counts, last remote input, remote input age, rollback count, and hash status.
- Move and fire in both windows for at least 30 seconds. Confirm both windows show the same frame progression, no desync, and reasonable remote input age.
- Shoot one ship with the other. Confirm both windows show the same winner and the loser ship is dimmed.
- Close the peer in one window and confirm both windows show a closed or failed peer state without continuing the network match.

## Two-Window Local Multiplayer

- For the simplest same-computer test, open two browser windows or tabs pointed at the local dev URL.
- If both windows share the same anonymous UID, check "Show my own lobbies for two-window testing" in the joining window.
- Create a lobby in the first window, then join that lobby from the second window.
- Confirm both windows log control pings and gameplay input frames.
- Confirm only one joining window can claim a lobby. A second join attempt should fail or report that the lobby is already connecting.
- For more realistic auth behavior, use two different browser profiles or one normal window plus one private/incognito window.
