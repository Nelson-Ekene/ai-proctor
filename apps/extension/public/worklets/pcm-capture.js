// AudioWorklet: hands the microphone signal to the offscreen document in fixed 512-sample
// frames (32 ms at the 16 kHz context rate), the frame size Silero VAD expects. Plain JS
// because worklet modules are loaded by URL. Frames are transferred, not copied or stored.
const FRAME = 512;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(FRAME);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.filled++] = channel[i];
        if (this.filled === FRAME) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(FRAME);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
