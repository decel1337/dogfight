// Запасні звуки, якщо ассет не завантажився: простий осцилятор.
const FALLBACK_TONES = {
  fire: { freq: 880, ms: 70, type: "square" },
  hit: { freq: 220, ms: 120, type: "sawtooth" },
  explode: { freq: 90, ms: 260, type: "sawtooth" },
};

// Підписка на події симуляції: fired / hit / exploded -> назви звуків.
const EVENT_TO_SOUND = { fired: "fire", hit: "hit", exploded: "explode" };

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
  }

  // Викликати ТІЛЬКИ з обробника жесту користувача (click/keydown),
  // інакше браузер залишить AudioContext у стані suspended.
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? window.webkitAudioContext;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  setBuffers(sounds) {
    for (const [name, buffer] of Object.entries(sounds)) {
      this.buffers.set(name, buffer);
    }
  }

  play(name) {
    if (!this.ctx || this.ctx.state !== "running") return;

    const buffer = this.buffers.get(name);
    if (buffer) {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.ctx.destination);
      source.start();
      return;
    }
    this.#beep(FALLBACK_TONES[name]);
  }

  #beep(tone) {
    if (!tone) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = tone.type;
    osc.frequency.value = tone.freq;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + tone.ms / 1000);
  }

  // Повертає функцію відписки.
  listenTo(events) {
    const handlers = Object.entries(EVENT_TO_SOUND).map(([type, sound]) => {
      const handler = () => this.play(sound);
      events.addEventListener(type, handler);
      return [type, handler];
    });
    return () => {
      for (const [type, handler] of handlers) {
        events.removeEventListener(type, handler);
      }
    };
  }
}
