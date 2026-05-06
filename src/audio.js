export class AudioController {
  constructor() {
    this.context = null;
    this.gain = null;
    this.oscillator = null;
    this.muted = true;
  }

  async setMuted(muted) {
    this.muted = muted;

    if (!muted) {
      await this.ensureContext();
    }

    this.update(0, false);
  }

  async ensureContext() {
    if (this.context) {
      if (this.context.state === "suspended") {
        await this.context.resume();
      }
      return;
    }

    const AudioContext = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContext) {
      return;
    }

    this.context = new AudioContext();
    this.gain = this.context.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(this.context.destination);

    this.oscillator = this.context.createOscillator();
    this.oscillator.type = "triangle";
    this.oscillator.frequency.value = 110;
    this.oscillator.connect(this.gain);
    this.oscillator.start();
  }

  update(buttonMask, running) {
    if (!this.context || !this.gain || !this.oscillator) {
      return;
    }

    const now = this.context.currentTime;
    const targetGain = this.muted || !running ? 0 : 0.025;
    const targetFrequency = 110 + ((buttonMask & 0xff) * 3);

    this.gain.gain.setTargetAtTime(targetGain, now, 0.04);
    this.oscillator.frequency.setTargetAtTime(targetFrequency, now, 0.04);
  }
}
