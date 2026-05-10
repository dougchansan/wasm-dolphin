export class AudioController {
  constructor() {
    this.context = null;
    this.gain = null;
    this.source = null;
    this.muted = true;
    this.available = false;
    this.pumpTimer = 0;
    this.pumpPending = false;
    this.nextPlayTime = 0;
    this.targetLeadSeconds = 0.12;
    this.startLeadSeconds = 0.025;
    this.chunkFrames = 1024;
    this.stats = "audio:off";
  }

  setSource(source) {
    this.source = typeof source === "function" ? source : null;
    this.available = Boolean(this.source);
    this.stats = this.source ? "audio:ready" : "audio:off";
    if (!this.muted) {
      this.startPump();
      void this.pump();
    }
  }

  async setMuted(muted) {
    this.muted = Boolean(muted);
    if (!muted) {
      await this.ensureContext();
      this.startPump();
      await this.pump();
    } else {
      this.stopPump();
    }
    this.update();
    return !this.muted && this.available;
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
    this.gain.gain.value = this.muted ? 0 : 1;
    this.gain.connect(this.context.destination);
  }

  update() {
    if (!this.context || !this.gain) {
      return;
    }

    const now = this.context.currentTime;
    this.gain.gain.setTargetAtTime(this.muted ? 0 : 1, now, 0.01);
  }

  startPump() {
    if (this.pumpTimer || this.muted || !this.source) {
      return;
    }

    this.pumpTimer = window.setInterval(() => {
      void this.pump();
    }, 20);
  }

  stopPump() {
    if (!this.pumpTimer) {
      return;
    }

    window.clearInterval(this.pumpTimer);
    this.pumpTimer = 0;
  }

  async pump() {
    if (this.muted || !this.source || !this.context || !this.gain || this.pumpPending) {
      return;
    }

    this.pumpPending = true;
    try {
      if (this.context.state === "suspended") {
        await this.context.resume();
      }

      const now = this.context.currentTime;
      if (this.nextPlayTime < now + this.startLeadSeconds) {
        this.nextPlayTime = now + this.startLeadSeconds;
      }

      let scheduled = 0;
      const horizon = now + this.targetLeadSeconds;
      while (!this.muted && this.nextPlayTime < horizon && scheduled < 6) {
        const chunk = await this.source(this.chunkFrames);
        if (!this.scheduleChunk(chunk)) {
          break;
        }
        scheduled += 1;
      }
    } catch (error) {
      this.available = false;
      this.stats = error instanceof Error ? error.message : String(error);
    } finally {
      this.pumpPending = false;
    }
  }

  scheduleChunk(chunk) {
    if (!chunk?.available || !chunk.samples || !this.context || !this.gain) {
      this.available = false;
      this.stats = chunk?.stats || "audio:unavailable";
      return false;
    }

    const channels = Math.min(2, Math.max(1, Number(chunk.channels) || 2));
    const sampleRate = Math.max(8000, Number(chunk.sampleRate) || this.context.sampleRate || 48000);
    const frames = Math.max(0, Math.min(Number(chunk.frames) || 0, this.chunkFrames * 4));
    const samples = chunk.samples instanceof Int16Array ? chunk.samples : new Int16Array(chunk.samples);
    const usableFrames = Math.min(frames, Math.floor(samples.length / channels));
    if (usableFrames <= 0) {
      this.available = Boolean(chunk.available);
      this.stats = chunk.stats || "audio:empty";
      return false;
    }

    const buffer = this.context.createBuffer(channels, usableFrames, sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      const output = buffer.getChannelData(channel);
      for (let frame = 0; frame < usableFrames; frame += 1) {
        output[frame] = samples[frame * channels + channel] / 32768;
      }
    }

    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    const startAt = Math.max(this.context.currentTime + this.startLeadSeconds, this.nextPlayTime);
    node.start(startAt);
    this.nextPlayTime = startAt + usableFrames / sampleRate;
    this.available = true;
    this.stats = chunk.stats || `audio:frames:${usableFrames}`;
    return true;
  }

  label() {
    return this.available ? (this.muted ? "Muted" : "Audio") : "Audio off";
  }
}
