/* The soft gate behind the call sound filter (app.html → fxProcessor).
   Between words it lowers the background - hiss, room noise, a line's static -
   by floorDb instead of muting it, so speech never chops: it opens within a
   few milliseconds of a voice and holds open across the small gaps in a
   sentence. Runs on the audio thread, so a busy page can't stall it. */
class VedioGate extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const p = (opts && opts.processorOptions) || {};
    const db = (v, d) => Math.pow(10, (typeof v === 'number' ? v : d) / 20);
    this.th = db(p.thresholdDb, -48);
    this.floor = db(p.floorDb, -12);
    const k = (ms) => Math.exp(-1 / (sampleRate * ms / 1000));
    this.envA = k(2); this.envR = k(60);   // level follower
    this.gA = k(4); this.gR = k(150);      // opens fast, closes gently
    this.holdN = Math.round(sampleRate * 0.25);
    this.env = 0; this.g = 1; this.hold = 0;
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length || !inp[0]) return true;
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let c = 0; c < inp.length; c++) { const v = Math.abs(inp[c][i]); if (v > x) x = v; }
      this.env = x > this.env ? this.envA * this.env + (1 - this.envA) * x : this.envR * this.env + (1 - this.envR) * x;
      if (this.env >= this.th) this.hold = this.holdN; else if (this.hold > 0) this.hold--;
      const target = this.hold > 0 ? 1 : this.floor;
      this.g = target > this.g ? this.gA * this.g + (1 - this.gA) * target : this.gR * this.g + (1 - this.gR) * target;
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.g;
    }
    return true;
  }
}
registerProcessor('vedio-gate', VedioGate);
