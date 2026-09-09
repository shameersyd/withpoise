/**
 * The browser half of the coaching voice: speech, a completion tone, and the
 * on/off switch that has to survive a reload.
 *
 * Kept apart from coach.js so the policy — what to say and when — stays pure
 * and testable. Everything here is a thin adapter over two APIs that fail in
 * their own ways, and it is written to degrade to silence rather than to throw.
 */

const STORAGE_KEY = "yoga.audio";

export class Voice {
  constructor() {
    this.synth = typeof speechSynthesis !== "undefined" ? speechSynthesis : null;
    this.ctx = null;
    this.primed = false;
    this._enabled = this.readPreference();
  }

  get supported() { return !!this.synth; }

  // localStorage throws outright in some privacy modes, so every touch of it is
  // guarded and the default survives.
  readPreference() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === null ? true : stored === "on";
    } catch { return true; }
  }

  get enabled() { return this._enabled; }

  set enabled(on) {
    this._enabled = on;
    try { localStorage.setItem(STORAGE_KEY, on ? "on" : "off"); } catch { /* ignore */ }
    if (!on) this.cancel();
  }

  /**
   * Must be called from inside a real user gesture, once.
   *
   * iOS will not speak and will not start an AudioContext unless the first one
   * of each happens in a tap handler, and it does not tell you it has refused —
   * the session simply runs in silence. So the Begin button pays for both.
   */
  prime() {
    if (this.primed) return;
    this.primed = true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) { this.ctx = new Ctx(); this.ctx.resume(); }
    } catch { this.ctx = null; }
    try {
      // A silent utterance is enough to unlock the queue.
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      this.synth && this.synth.speak(u);
    } catch { /* ignore */ }
  }

  cancel() { try { this.synth && this.synth.cancel(); } catch { /* ignore */ } }

  speak(text, { interrupt = false } = {}) {
    if (!this._enabled || !this.synth || !text) return;
    try {
      // Chrome and some Android builds park the queue after a quiet spell and
      // then swallow everything sent to it. Nudging it costs nothing.
      if (this.synth.paused) this.synth.resume();

      // Never let a backlog build: by the time three corrections have queued up
      // the body has moved on and every one of them is a lie.
      if (interrupt || this.synth.speaking || this.synth.pending) this.synth.cancel();

      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = 1.0;
      u.pitch = 1.0;
      this.synth.speak(u);
    } catch { /* a voice that throws is still just silence */ }
  }

  /**
   * The completion chime — two rising notes, short. A tone rather than a word
   * because it has to land the instant the hold finishes, and speech does not.
   */
  chime() {
    if (!this._enabled || !this.ctx) return;
    try {
      if (this.ctx.state === "suspended") this.ctx.resume();
      const t0 = this.ctx.currentTime;
      for (const [i, freq] of [660, 990].entries()) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const start = t0 + i * 0.14;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.30);
        osc.connect(gain).connect(this.ctx.destination);
        osc.start(start);
        osc.stop(start + 0.32);
      }
    } catch { /* ignore */ }
  }
}
