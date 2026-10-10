class ScreenSpotMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(1024);
    this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const first = channels[0];
    for (let i = 0; i < first.length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      this.samples[this.offset++] = value / channels.length;
      if (this.offset === this.samples.length) {
        const chunk = this.samples;
        this.port.postMessage(chunk, [chunk.buffer]);
        this.samples = new Float32Array(1024);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('screenspot-mic', ScreenSpotMic);
