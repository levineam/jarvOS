export class WebAudioSpeechEnergy {
  private readonly samples: Uint8Array<ArrayBuffer>;
  private smoothed = 0;

  constructor(private readonly analyser: AnalyserNode) {
    analyser.fftSize = Math.max(256, Math.min(2048, analyser.fftSize));
    analyser.smoothingTimeConstant = 0.72;
    this.samples = new Uint8Array(analyser.fftSize);
  }

  sample(): number {
    this.analyser.getByteTimeDomainData(this.samples);
    let sumSquares = 0;
    for (const sample of this.samples) {
      const centered = (sample - 128) / 128;
      sumSquares += centered * centered;
    }
    const rms = Math.sqrt(sumSquares / this.samples.length);
    const normalized = Math.min(1, Math.max(0, (rms - 0.018) / 0.18));
    this.smoothed += (normalized - this.smoothed) * (normalized > this.smoothed ? 0.36 : 0.16);
    return this.smoothed;
  }
}
