export const SIM_FPS = 60;
export const SIM_DT_MS = 1000 / SIM_FPS;

export interface FixedLoop {
  readonly start: () => void;
  readonly stop: () => void;
}

export function createFixedLoop(onStep: () => void, onRender: (alpha: number) => void): FixedLoop {
  let running = false;
  let previousTime = 0;
  let accumulator = 0;
  let animationFrameId = 0;

  const frame = (time: number) => {
    if (!running) {
      return;
    }

    const elapsed = Math.min(250, time - previousTime);
    previousTime = time;
    accumulator += elapsed;

    while (accumulator >= SIM_DT_MS) {
      onStep();
      accumulator -= SIM_DT_MS;
    }

    onRender(accumulator / SIM_DT_MS);
    animationFrameId = requestAnimationFrame(frame);
  };

  return {
    start() {
      if (running) {
        return;
      }

      running = true;
      previousTime = performance.now();
      animationFrameId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(animationFrameId);
    },
  };
}
