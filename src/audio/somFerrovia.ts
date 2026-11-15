/**
 * Sino da passagem de nível e buzina do trem (WebAudio sintetizado), com volume
 * pela distância até o carro.
 */
export class SomFerrovia {
  private ctx: AudioContext | null = null;
  private saida!: GainNode;
  private buzina!: GainNode;
  private proximoSino = 0;
  private volumeGeral = 0.8;

  iniciar(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.saida = ctx.createGain();
    this.saida.gain.value = this.volumeGeral;
    this.saida.connect(ctx.destination);

    // Buzina: acorde de dois tons de locomotiva (serra filtrada), sempre tocando com ganho 0.
    this.buzina = ctx.createGain();
    this.buzina.gain.value = 0;
    const filtro = ctx.createBiquadFilter();
    filtro.type = 'lowpass';
    filtro.frequency.value = 1800;
    for (const f of [311, 370, 466]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.18;
      o.connect(g).connect(filtro);
      o.start();
    }
    filtro.connect(this.buzina).connect(this.saida);
  }

  set volume(v: number) {
    this.volumeGeral = v;
    if (this.ctx) this.saida.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Toca uma badalada metálica (parciais inarmônicas com decaimento). */
  private badalada(ganho: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    for (const [f, a, d] of [[880, 1, 0.9], [2210, 0.5, 0.5], [3530, 0.3, 0.3], [1330, 0.35, 0.7]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25 * a * ganho + 1e-4, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(this.saida);
      o.start(t);
      o.stop(t + d + 0.05);
    }
  }

  /**
   * @param sino passagem de nível em alerta/fechada
   * @param buzina trem buzinando
   * @param distSino distância (m) do carro até a passagem
   * @param distTrem distância (m) do carro até o trem
   */
  atualizar(sino: boolean, buzina: boolean, distSino: number, distTrem: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const atenuar = (d: number, ref: number) => Math.min(1, ref / Math.max(ref, d));
    if (sino && ctx.currentTime >= this.proximoSino) {
      this.badalada(atenuar(distSino, 12));
      this.proximoSino = ctx.currentTime + 0.55; // ~110 badaladas/min
    }
    const gb = buzina ? 0.5 * atenuar(distTrem, 25) : 0;
    this.buzina.gain.setTargetAtTime(gb, ctx.currentTime, buzina ? 0.03 : 0.12);
  }
}
