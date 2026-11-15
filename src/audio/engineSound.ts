/**
 * Som do motor sintetizado (WebAudio): a frequência acompanha o RPM e o
 * número de cilindros — essencial para “sentir” o ponto da embreagem.
 */
export class SomMotor {
  private ctx: AudioContext | null = null;
  private osc1!: OscillatorNode;
  private osc2!: OscillatorNode;
  private filtro!: BiquadFilterNode;
  private ganho!: GainNode;
  private partidaOsc!: OscillatorNode;
  private partidaGanho!: GainNode;
  private master!: GainNode;

  iniciar(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);

    this.filtro = ctx.createBiquadFilter();
    this.filtro.type = 'lowpass';
    this.filtro.Q.value = 2;
    this.ganho = ctx.createGain();
    this.ganho.gain.value = 0;
    this.filtro.connect(this.ganho).connect(this.master);

    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    this.osc1.connect(this.filtro);
    this.osc2.connect(g2).connect(this.filtro);
    this.osc1.start();
    this.osc2.start();

    this.partidaOsc = ctx.createOscillator();
    this.partidaOsc.type = 'square';
    this.partidaGanho = ctx.createGain();
    this.partidaGanho.gain.value = 0;
    const fp = ctx.createBiquadFilter();
    fp.type = 'lowpass';
    fp.frequency.value = 600;
    this.partidaOsc.connect(fp).connect(this.partidaGanho).connect(this.master);
    this.partidaOsc.start();
  }

  /** `cilindros`: 4 tempos → disparos por segundo = rpm/60 × cilindros/2. */
  atualizar(rpm: number, carga: number, ligado: boolean, partida: boolean, cilindros = 4): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const disparo = Math.max(1, (Math.abs(rpm) / 60) * (cilindros / 2));
    this.osc1.frequency.setTargetAtTime(disparo * 2, t, 0.02);
    this.osc2.frequency.setTargetAtTime(disparo, t, 0.02);
    this.filtro.frequency.setTargetAtTime(250 + carga * 1800 + Math.abs(rpm) * 0.15, t, 0.03);
    const vol = ligado ? 0.12 + 0.22 * carga : Math.min(0.1, Math.abs(rpm) / 3000);
    this.ganho.gain.setTargetAtTime(vol, t, 0.04);
    this.partidaOsc.frequency.setTargetAtTime(9 + Math.abs(rpm) / 25, t, 0.02);
    this.partidaGanho.gain.setTargetAtTime(partida && !ligado ? 0.12 : 0, t, 0.03);
  }

  clique(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = 1800;
    g.gain.setValueAtTime(0.06, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.03);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + 0.04);
  }
}
