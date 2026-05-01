import { describe, expect, it } from 'vitest';

import { readGamepadBits } from './input';
import { InputBits } from './sim/types';

function gamepad(overrides: Partial<Pick<Gamepad, 'axes' | 'buttons'>>): Pick<Gamepad, 'axes' | 'buttons'> {
  return {
    axes: overrides.axes ?? [],
    buttons: overrides.buttons ?? [],
  };
}

function button(pressed: boolean): GamepadButton {
  return { pressed, touched: pressed, value: pressed ? 1 : 0 };
}

describe('gamepad input mapping', () => {
  it('maps left stick and face buttons to ship input bits', () => {
    const input = readGamepadBits(
      gamepad({
        axes: [-1, -1],
        buttons: [button(true)],
      }),
    );

    expect(input & InputBits.TurnLeft).toBe(InputBits.TurnLeft);
    expect(input & InputBits.Thrust).toBe(InputBits.Thrust);
    expect(input & InputBits.FirePrimary).toBe(InputBits.FirePrimary);
  });

  it('maps d-pad and shoulder buttons as alternates', () => {
    const buttons = Array.from({ length: 16 }, () => button(false));
    buttons[4] = button(true);
    buttons[7] = button(true);
    buttons[15] = button(true);

    const input = readGamepadBits(gamepad({ buttons }));

    expect(input & InputBits.TurnRight).toBe(InputBits.TurnRight);
    expect(input & InputBits.Thrust).toBe(InputBits.Thrust);
    expect(input & InputBits.FireSecondary).toBe(InputBits.FireSecondary);
  });
});
