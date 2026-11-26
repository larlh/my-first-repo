/* global AudioWorkletProcessor, registerProcessor */
/* Audio thread side of the dictation capture (loaded with `audioWorklet.addModule`). It only
 * gathers the mono input into blocks and hands them to the page; resampling and phrase
 * detection run there (`pcm.ts`, `segmenter.ts`). Plain JavaScript on purpose: worklet modules
 * are served as they are, outside the bundle. */

const BLOCK_FRAMES = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK_FRAMES);
    this.filled = 0;
    this.active = true;
    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.active = false;
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      let offset = 0;
      while (offset < channel.length) {
        const count = Math.min(channel.length - offset, BLOCK_FRAMES - this.filled);
        this.block.set(channel.subarray(offset, offset + count), this.filled);
        this.filled += count;
        offset += count;
        if (this.filled === BLOCK_FRAMES) {
          const full = this.block;
          this.block = new Float32Array(BLOCK_FRAMES);
          this.filled = 0;
          this.port.postMessage(full, [full.buffer]);
        }
      }
    }
    return this.active;
  }
}

registerProcessor('parlante-capture', CaptureProcessor);
