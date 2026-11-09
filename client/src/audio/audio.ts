import type { WorldEvents } from "@dogfight/shared/sim";

type SoundName = "fire" | "hit" | "explode";

// Запасні звуки, якщо ассет не завантажився: простий осцилятор.
const FALLBACK_TONES: Record<
  SoundName,
  { freq: number; ms: number; type: OscillatorType }
> = {
  fire: { freq: 880, ms: 70, type: "square" },
  hit: { freq: 220, ms: 120, type: "sawtooth" },
  explode: { freq: 90, ms: 260, type: "sawtooth" },
};

// Підписка на події симуляції: fired / hit / exploded -> назви звуків.
// `satisfies` перевіряє, що кожна подія світу має звук, і зберігає літерали.
const EVENT_TO_SOUND = {
  fired: "fire",
  hit: "hit",
  exploded: "explode",
} as const satisfies Record<keyof WorldEvents, SoundName>;

const isSoundName = (name: string): name is SoundName => name in FALLBACK_TONES;

// Джерело подій, на які підписується аудіо (EventTarget із CustomEvent).
export type EventSource = Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
>;

export class AudioManager {
  ctx: AudioContext | null = null;
  readonly buffers = new Map<string, AudioBuffer>();

  // Викликати ТІЛЬКИ з обробника жесту користувача (click/keydown),
  // інакше браузер залишить AudioContext у стані suspended.
  unlock(): AudioContext {
    if (!this.ctx) {
      // Старі Safari мають лише webkitAudioContext (Reflect.get -> any, без приведення).
      const legacy: typeof AudioContext | undefined = Reflect.get(
        window,
        "webkitAudioContext",
      );
      const Ctx = window.AudioContext ?? legacy;
      if (!Ctx) throw new Error("AudioContext не підтримується");
      this.ctx = new Ctx();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  setBuffers(sounds: Record<string, AudioBuffer>): void {
    for (const [name, buffer] of Object.entries(sounds)) {
      this.buffers.set(name, buffer);
    }
  }

  play(name: string): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;

    const buffer = this.buffers.get(name);
    if (buffer) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
      return;
    }
    if (isSoundName(name)) this.#beep(ctx, FALLBACK_TONES[name]);
  }

  #beep(
    ctx: AudioContext,
    tone: { freq: number; ms: number; type: OscillatorType },
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = tone.type;
    osc.frequency.value = tone.freq;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + tone.ms / 1000);
  }

  // Повертає функцію відписки.
  listenTo(events: EventSource): () => void {
    const handlers = Object.entries(EVENT_TO_SOUND).map(([type, sound]) => {
      const handler = (): void => this.play(sound);
      events.addEventListener(type, handler);
      return [type, handler] as const;
    });
    return () => {
      for (const [type, handler] of handlers) {
        events.removeEventListener(type, handler);
      }
    };
  }
}
