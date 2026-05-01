import { InputBits, type FrameInputs } from './sim/types';

const keys = new Set<string>();
const GAMEPAD_AXIS_THRESHOLD = 0.35;
const GAMEPAD_BUTTON_ACTIVE_THRESHOLD = 0.1;
const STANDARD_GAMEPAD_BUTTON_LABELS: Record<number, string> = {
  0: 'A/Cross',
  1: 'B/Circle',
  2: 'X/Square',
  3: 'Y/Triangle',
  4: 'LB/L1',
  5: 'RB/R1',
  6: 'LT/L2',
  7: 'RT/R2',
  8: 'Back/Share',
  9: 'Start/Options',
  10: 'Left Stick',
  11: 'Right Stick',
  12: 'D-pad Up',
  13: 'D-pad Down',
  14: 'D-pad Left',
  15: 'D-pad Right',
  16: 'Home',
};

const PLAYER_ONE_KEYS: Record<string, InputBits> = {
  ArrowUp: InputBits.Thrust,
  KeyW: InputBits.Thrust,
  ArrowLeft: InputBits.TurnLeft,
  KeyA: InputBits.TurnLeft,
  ArrowRight: InputBits.TurnRight,
  KeyD: InputBits.TurnRight,
  Space: InputBits.FirePrimary,
  ShiftRight: InputBits.FireSecondary,
  KeyE: InputBits.FireSecondary,
};

const PLAYER_TWO_KEYS: Record<string, InputBits> = {
  KeyI: InputBits.Thrust,
  KeyJ: InputBits.TurnLeft,
  KeyL: InputBits.TurnRight,
  Enter: InputBits.FirePrimary,
  ShiftLeft: InputBits.FireSecondary,
  KeyO: InputBits.FireSecondary,
};

export interface InputDeviceStatus {
  readonly keyboardActive: boolean;
  readonly gamepads: readonly GamepadDeviceStatus[];
}

export interface GamepadDeviceStatus {
  readonly id: string;
  readonly pressedButtons: readonly GamepadButtonStatus[];
}

export interface GamepadButtonStatus {
  readonly index: number;
  readonly label: string;
  readonly value: number;
}

export function bindKeyboard(options: { readonly shouldCapture?: (event: KeyboardEvent) => boolean } = {}): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (isGameKey(event.code) && shouldCaptureKeyboard(event, options.shouldCapture)) {
      event.preventDefault();
      keys.add(event.code);
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (isGameKey(event.code) && shouldCaptureKeyboard(event, options.shouldCapture)) {
      event.preventDefault();
      keys.delete(event.code);
    }
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    keys.clear();
  };
}

export function readLocalInputs(): FrameInputs {
  return [
    readKeyboardInput(PLAYER_ONE_KEYS) | readGamepadInput(0),
    readKeyboardInput(PLAYER_TWO_KEYS) | readGamepadInput(1),
  ];
}

export function readInputDeviceStatus(): InputDeviceStatus {
  return {
    keyboardActive: keys.size > 0,
    gamepads: readGamepads().map(readGamepadStatus),
  };
}

export function readGamepadInput(index: number): number {
  const gamepad = readGamepads()[index];
  return gamepad ? readGamepadBits(gamepad) : 0;
}

export function readGamepadBits(gamepad: Pick<Gamepad, 'axes' | 'buttons'>): number {
  let input = 0;
  const xAxis = gamepad.axes[0] ?? 0;
  const yAxis = gamepad.axes[1] ?? 0;

  if (xAxis < -GAMEPAD_AXIS_THRESHOLD || gamepad.buttons[14]?.pressed) {
    input |= InputBits.TurnLeft;
  }

  if (xAxis > GAMEPAD_AXIS_THRESHOLD || gamepad.buttons[15]?.pressed) {
    input |= InputBits.TurnRight;
  }

  if (yAxis < -GAMEPAD_AXIS_THRESHOLD || gamepad.buttons[12]?.pressed || gamepad.buttons[7]?.pressed) {
    input |= InputBits.Thrust;
  }

  if (gamepad.buttons[0]?.pressed || gamepad.buttons[5]?.pressed) {
    input |= InputBits.FirePrimary;
  }

  if (gamepad.buttons[1]?.pressed || gamepad.buttons[4]?.pressed) {
    input |= InputBits.FireSecondary;
  }

  return input;
}

function readKeyboardInput(mapping: Record<string, InputBits>): number {
  let input = 0;

  for (const [code, bit] of Object.entries(mapping)) {
    if (keys.has(code)) {
      input |= bit;
    }
  }

  return input;
}

function isGameKey(code: string): boolean {
  return code in PLAYER_ONE_KEYS || code in PLAYER_TWO_KEYS;
}

function shouldCaptureKeyboard(event: KeyboardEvent, shouldCapture?: (event: KeyboardEvent) => boolean): boolean {
  if (shouldCapture && !shouldCapture(event)) {
    return false;
  }

  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return true;
  }

  return !target.closest('button, input, select, textarea, [contenteditable="true"]');
}

function readGamepadStatus(gamepad: Gamepad): GamepadDeviceStatus {
  const pressedButtons = gamepad.buttons
    .map((button, index): GamepadButtonStatus | null => {
      if (!button.pressed && button.value <= GAMEPAD_BUTTON_ACTIVE_THRESHOLD) {
        return null;
      }

      return {
        index,
        label: STANDARD_GAMEPAD_BUTTON_LABELS[index] ?? `Button ${index}`,
        value: button.value,
      };
    })
    .filter((button): button is GamepadButtonStatus => button !== null);

  return {
    id: gamepad.id,
    pressedButtons,
  };
}

function readGamepads(): Gamepad[] {
  if (!('getGamepads' in navigator)) {
    return [];
  }

  return navigator.getGamepads().filter((gamepad): gamepad is Gamepad => gamepad !== null);
}
