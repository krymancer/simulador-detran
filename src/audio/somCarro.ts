/**
 * Som do carro inteiro, 100% sintetizado com WebAudio (sem amostras baixadas).
 *
 * Tudo que é “gravado” (ruídos, LFOs aleatórios, batidas, cliques) é gerado
 * em AudioBuffers na inicialização; em tempo real só rodam nós nativos
 * (osciladores, filtros, ganhos) — nada de ScriptProcessor/AudioWorklet.
 *
 * Motor (4 cilindros, 4 tempos): um ciclo completo = 2 voltas do virabrequim
 * = 4 explosões. A frequência do ciclo é rpm/120 e a de disparo é rpm/30
 * (= rpm/60 × 2). Um único ConstantSourceNode carrega a frequência do ciclo
 * e alimenta todos os osciladores do motor por ganhos fixos (×1, ×4, ×8),
 * então tudo fica travado em fase e acompanha o rpm sem “derrapar”.
 *
 * Camadas do motor:
 *  (a) combustão: PeriodicWave desenhada no tempo — um ciclo com 4 pulsos de
 *      escape levemente diferentes entre si (amplitude e instante), o que cria
 *      as ordens “quebradas” (½ da de disparo, 1ª do virabrequim) do ronco real.
 *      Duas tabelas: em carga (pulso seco, áspero, grave) e em desaceleração
 *      (pulso fraco e ressonante → oco/assobiado); o mix segue a carga.
 *  (b) escapamento: ruído passa-faixa em torno dos harmônicos de disparo,
 *      modulado em amplitude por um trem de pulsos na frequência de disparo.
 *  (c) admissão: chiado da borboleta/coletor, sobe com carga e rpm.
 *  (d) comando de válvulas: tique agudo e baixo a 2× a frequência de disparo.
 *  + saturação suave (mais “rasgado” em carga), ressonâncias fixas do
 *    escapamento, jitter na lenta, corte do limitador, estalos em overrun.
 */

export interface EstadoSom {
  rpm: number;            // rpm do motor (pode ser 0 ou levemente negativo parado)
  carga: number;          // 0..1 acelerador efetivo (inclui o controle de lenta)
  ligado: boolean;        // motor funcionando
  partida: boolean;       // motor de partida girando (botão segurado, motor ainda não pegou)
  ignicao: boolean;       // chave ligada
  velocidade: number;     // velocidade do carro, m/s (absoluta)
  escorregamento: number; // maior velocidade de deslizamento entre as rodas no chão, m/s
  /** Maior fração da aderência em uso entre os pneus (0..1): o “arrastar” perto do limite. */
  aderencia?: number;
  freio: number;          // 0..1 pedal de freio
  embreagem: number;      // 0..1 pedal de embreagem (1 = pisado)
  marcha: number;         // marcha engatada −1..5
  cockpit: boolean;       // câmera dentro do carro
}

export type EventoSom =
  | 'marcha'
  | 'arranhou'
  | 'apagou'
  | 'pegou'
  | 'freioDeMao'
  | 'cinto'
  | 'seta'
  | 'meioFio'
  | 'batida';

export interface OpcoesSomCarro {
  /** Contexto já criado (ex.: OfflineAudioContext para testes). Sem ele, `iniciar()` cria um AudioContext. */
  ctx?: BaseAudioContext;
  rpmMarchaLenta?: number;
  rpmCorte?: number;
}

const TAU = Math.PI * 2;
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const suave = (a: number, b: number, x: number) => {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};

/* ------------------------------------------------------------------ */
/* Utilitários de síntese offline (preenchem AudioBuffers)             */
/* ------------------------------------------------------------------ */

/** PRNG determinístico (mulberry32) → [-1, 1). */
function prng(semente: number): () => number {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Biquad RBJ em JS, só para gerar buffers. */
class Bq {
  private b0 = 0; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(tipo: 'lp' | 'hp' | 'bp', f: number, q: number, sr: number) {
    const w = (TAU * Math.min(f, sr * 0.45)) / sr;
    const c = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    const a0 = 1 + al;
    let b0: number, b1: number, b2: number;
    if (tipo === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else if (tipo === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else { b0 = al; b1 = 0; b2 = -al; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = (-2 * c) / a0; this.a2 = (1 - al) / a0;
  }
  p(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

function gerar(ctx: BaseAudioContext, dur: number, f: (t: number, sr: number) => number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.round(dur * sr));
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = f(i / sr, sr);
  // Rampa de 2 ms nas pontas: nada de clique ao começar/terminar.
  const r = Math.min(n >> 1, Math.round(sr * 0.002));
  for (let i = 0; i < r; i++) d[n - 1 - i] *= i / r;
  return buf;
}

/** Ruído em loop sem emenda (crossfade do fim com o começo). */
function ruido(ctx: BaseAudioContext, dur: number, cor: 'branco' | 'rosa' | 'marrom', semente: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.round(dur * sr);
  const extra = Math.round(sr * 0.05);
  const tmp = new Float32Array(n + extra);
  const rnd = prng(semente);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, m = 0;
  for (let i = 0; i < n + extra; i++) {
    const w = rnd();
    if (cor === 'branco') tmp[i] = w * 0.5;
    else if (cor === 'rosa') {
      // Paul Kellet
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      tmp[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.09;
      b6 = w * 0.115926;
    } else {
      m = (m + w * 0.02) * 0.995; // integrador com vazamento (sem DC)
      tmp[i] = m * 2.2;
    }
  }
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = tmp[i];
  for (let i = 0; i < extra; i++) {
    const k = i / extra; // começo recebe a cauda: emenda contínua
    d[i] = tmp[i] * k + tmp[n + i] * (1 - k);
  }
  return buf;
}

/** LFO aleatório suave (−1..1), em loop: nós cosseno-interpolados a `nosPorSeg`. */
function lfoAleatorio(ctx: BaseAudioContext, dur: number, nosPorSeg: number, semente: number): AudioBuffer {
  const rnd = prng(semente);
  const k = Math.round(dur * nosPorSeg);
  const nos = Array.from({ length: k }, () => rnd());
  const sr = ctx.sampleRate;
  const n = Math.round(dur * sr);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const p = (i / n) * k;
    const j = Math.floor(p);
    const u = (1 - Math.cos((p - j) * Math.PI)) / 2;
    d[i] = nos[j % k] * (1 - u) + nos[(j + 1) % k] * u;
  }
  return buf;
}

/**
 * PeriodicWave a partir de um período desenhado no tempo (fase 0..1).
 * Remove DC, normaliza o pico para `pico` e desliga a normalização do navegador
 * (para os ganhos significarem a mesma coisa em todas as tabelas).
 */
function ondaDoTempo(ctx: BaseAudioContext, f: (fase: number) => number, harmonicos: number, pico = 1): PeriodicWave {
  const N = 4096;
  const x = new Float64Array(N);
  let media = 0;
  for (let i = 0; i < N; i++) { x[i] = f(i / N); media += x[i]; }
  media /= N;
  let mx = 1e-9;
  for (let i = 0; i < N; i++) { x[i] -= media; mx = Math.max(mx, Math.abs(x[i])); }
  const esc = pico / mx;
  const re = new Float32Array(harmonicos + 1);
  const im = new Float32Array(harmonicos + 1);
  for (let k = 1; k <= harmonicos; k++) {
    // DFT com rotação incremental (sem sin/cos por amostra)
    const dc = Math.cos((TAU * k) / N), ds = Math.sin((TAU * k) / N);
    let c = 1, sn = 0, a = 0, b = 0;
    for (let i = 0; i < N; i++) {
      a += x[i] * c;
      b += x[i] * sn;
      const c2 = c * dc - sn * ds;
      sn = sn * dc + c * ds;
      c = c2;
    }
    re[k] = ((2 * a) / N) * esc;
    im[k] = ((2 * b) / N) * esc;
  }
  return ctx.createPeriodicWave(re, im, { disableNormalization: true });
}

/** Ciclo do motor: 4 pulsos (um por cilindro) com pequenas diferenças entre eles. */
function cicloMotor(pulso: (u: number) => number, amps: number[], desloc: number[], extra?: (fase: number) => number) {
  return (fase: number) => {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      let u = fase - (i / 4 + desloc[i]);
      u -= Math.floor(u);
      s += amps[i] * pulso(u);
    }
    return s + (extra ? extra(fase) : 0);
  };
}

/* ------------------------------------------------------------------ */

export class SomCarro {
  private ctx: BaseAudioContext | null = null;
  private readonly ctxExterno?: BaseAudioContext;
  private readonly rpmLenta: number;
  private readonly rpmCorte: number;
  private vol = 0.8;

  private master!: GainNode;
  private busExt!: GainNode;
  private busInt!: GainNode;
  private filtroCabine!: BiquadFilterNode;
  private boomCabine!: BiquadFilterNode;

  // motor
  private freqCiclo!: ConstantSourceNode;
  private jitterFreq!: GainNode;
  private jitterAmp!: GainNode;
  private gA!: GainNode;
  private gB!: GainNode;
  private gEsc!: GainNode;
  private bpEsc!: BiquadFilterNode;
  private bpEsc2!: BiquadFilterNode;
  private preSat!: GainNode;
  private posSat!: GainNode;
  private shelf!: BiquadFilterNode;
  private lpMotor!: BiquadFilterNode;
  private gAdm!: GainNode;
  private bpAdm!: BiquadFilterNode;
  private limite!: GainNode;
  private profCorte!: GainNode;
  private flare!: GainNode;
  private gate!: GainNode;
  private mecanico!: GainNode;
  private motorCabine!: GainNode;
  private gValv!: GainNode;
  private gChug!: GainNode;
  private oscPartida!: OscillatorNode;
  private oscPartidaW!: OscillatorNode;
  private gPartida!: GainNode;
  private oscCambio!: OscillatorNode;
  private gCambio!: GainNode;

  // pneus / ambiente
  private lpRua!: BiquadFilterNode;
  private gRua!: GainNode;
  private gBanda!: GainNode;
  private bpCant1!: BiquadFilterNode;
  private bpCant2!: BiquadFilterNode;
  private oscCant!: OscillatorNode;
  private gCant!: GainNode;
  private gArraste!: GainNode;
  private bpArraste!: BiquadFilterNode;
  private gVento!: GainNode;
  private bpVento!: BiquadFilterNode;
  private gFreio!: GainNode;

  // buffers de eventos
  private buf: Record<string, AudioBuffer> = {};
  private setaAlterna = false;
  private ignicaoAntes = false;
  private corteAtivo = 0;

  constructor(opcoes: OpcoesSomCarro = {}) {
    this.ctxExterno = opcoes.ctx;
    this.rpmLenta = opcoes.rpmMarchaLenta ?? 850;
    this.rpmCorte = opcoes.rpmCorte ?? 6600;
  }

  set volume(v: number) {
    this.vol = clamp(v, 0, 1);
    if (this.ctx) this.master.gain.setTargetAtTime(this.vol, this.ctx.currentTime, 0.05);
  }
  get volume(): number {
    return this.vol;
  }

  iniciar(): void {
    if (this.ctx) {
      if (this.ctx instanceof AudioContext && this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = this.ctxExterno ?? new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.montar(ctx);
    if (ctx instanceof AudioContext && ctx.state === 'suspended') void ctx.resume();
  }

  /* ---------------- grafo ---------------- */

  private montar(ctx: BaseAudioContext): void {
    const ganho = (v: number) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const filtro = (tipo: BiquadFilterType, f: number, q = 0.707, g = 0) => {
      const b = ctx.createBiquadFilter();
      b.type = tipo; b.frequency.value = f; b.Q.value = q; b.gain.value = g;
      return b;
    };
    const fonte = (b: AudioBuffer, taxa = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = b; s.loop = true; s.playbackRate.value = taxa;
      s.start(0, Math.random() * b.duration);
      return s;
    };

    // ---- buffers ----
    const branco = ruido(ctx, 3.1, 'branco', 11);
    const rosa = ruido(ctx, 2.7, 'rosa', 23);
    const marrom = ruido(ctx, 3.3, 'marrom', 37);
    const lfo1 = lfoAleatorio(ctx, 7, 9, 41);
    const lfo2 = lfoAleatorio(ctx, 5, 5, 53);
    this.gerarEventos(ctx);

    // ---- saída: compressor → limitador → volume ----
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 10; comp.ratio.value = 3.5;
    comp.attack.value = 0.005; comp.release.value = 0.2;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20;
    lim.attack.value = 0.001; lim.release.value = 0.08;
    this.master = ganho(this.vol);
    comp.connect(lim).connect(this.master).connect(ctx.destination);

    const semDC = filtro('highpass', 18, 0.707);
    semDC.connect(comp);
    this.busInt = ganho(1);
    this.busInt.connect(semDC);
    this.busExt = ganho(1);
    this.filtroCabine = filtro('lowpass', 15000, 0.6);
    this.boomCabine = filtro('peaking', 110, 1.3, 0);
    this.busExt.connect(this.filtroCabine).connect(this.boomCabine).connect(semDC);

    const srcBranco = fonte(branco);
    const srcRosa = fonte(rosa);
    const srcMarrom = fonte(marrom);
    const srcLfo1 = fonte(lfo1);
    const srcLfo2 = fonte(lfo2, 1.3);

    // ---- frequência do ciclo (rpm/120), compartilhada ----
    this.freqCiclo = ctx.createConstantSource();
    this.freqCiclo.offset.value = 0;
    this.freqCiclo.start();
    this.jitterFreq = ganho(0);
    srcLfo1.connect(this.jitterFreq).connect(this.freqCiclo.offset);
    const osc = (mult: number, onda?: PeriodicWave, tipo: OscillatorType = 'sine') => {
      const o = ctx.createOscillator();
      if (onda) o.setPeriodicWave(onda); else o.type = tipo;
      o.frequency.value = 0;
      const m = ganho(mult);
      this.freqCiclo.connect(m).connect(o.frequency);
      o.start();
      return o;
    };

    // (a) combustão — tabela em carga: pulso seco + toque de rarefação + anel no 3º harmônico de disparo
    const ondaCarga = ondaDoTempo(ctx, cicloMotor(
      (u) => {
        const ataque = 1 - Math.exp(-u / 0.0015);
        const seco = ataque * Math.exp(-u / 0.007) * 0.9;
        const anel = ataque * Math.exp(-u / 0.03) * Math.sin((TAU * u) / 0.085);
        const raref = -0.35 * Math.exp(-u / 0.07) * (1 - Math.exp(-u / 0.012));
        return seco + anel + raref;
      },
      [1, 0.84, 1.07, 0.9], [0, 0.007, -0.004, 0.01],
    ), 600);
    // tabela de desaceleração: pulsos fracos, anel no 5º e 8º (oco, assobiado)
    const ondaAlivio = ondaDoTempo(ctx, cicloMotor(
      (u) => {
        const ataque = 1 - Math.exp(-u / 0.004);
        return ataque * (0.55 * Math.exp(-u / 0.05) * Math.sin((TAU * u) / 0.0505)
          + 0.28 * Math.exp(-u / 0.022) * Math.sin((TAU * u) / 0.0313));
      },
      [1, 0.93, 1.03, 0.95], [0, 0.005, -0.003, 0.007],
      (f) => 0.12 * Math.sin(TAU * f * 24) + 0.05 * Math.sin(TAU * f * 36),
    ), 600);
    const oscA = osc(1, ondaCarga);
    const oscB = osc(1, ondaAlivio);
    this.gA = ganho(0);
    this.gB = ganho(0);
    this.jitterAmp = ganho(0);
    srcLfo2.connect(this.jitterAmp).connect(this.gA.gain);

    const somaMotor = ganho(1);
    oscA.connect(this.gA).connect(somaMotor);
    oscB.connect(this.gB).connect(somaMotor);

    // moduladores na frequência de disparo (×4) e do comando (×8)
    const ondaPulsoDisparo = ondaDoTempo(ctx, (u) => Math.exp(-u / 0.15), 64, 0.85);
    const modDisparo = osc(4, ondaPulsoDisparo);
    const ondaPulsoValv = ondaDoTempo(ctx, (u) => Math.exp(-u / 0.04), 64, 1);
    const modValv = osc(8, ondaPulsoValv);

    // (b) escapamento: ruído × pulso
    this.bpEsc = filtro('bandpass', 200, 1.8);
    this.bpEsc2 = filtro('bandpass', 600, 1.2);
    const amEsc = ganho(0.22);
    modDisparo.connect(ganho(1)).connect(amEsc.gain);
    this.gEsc = ganho(0);
    srcBranco.connect(this.bpEsc).connect(amEsc);
    srcRosa.connect(this.bpEsc2).connect(amEsc);
    amEsc.connect(this.gEsc).connect(somaMotor);

    // saturação + coloração do escapamento
    this.preSat = ganho(1);
    const sat = ctx.createWaveShaper();
    const curva = new Float32Array(2048);
    for (let i = 0; i < curva.length; i++) {
      const x = (i / (curva.length - 1)) * 2 - 1;
      curva[i] = Math.tanh(2.2 * x) / Math.tanh(2.2);
    }
    sat.curve = curva;
    sat.oversample = '2x';
    this.posSat = ganho(1);
    this.shelf = filtro('lowshelf', 190, 0.707, 2);
    const ressoMufla = filtro('peaking', 95, 1.4, 2.5);
    const ressoTubo = filtro('peaking', 430, 2.2, 3);
    const corteGrave = filtro('highpass', 22, 0.707);
    this.lpMotor = filtro('lowpass', 1500, 0.8);
    somaMotor.connect(this.preSat).connect(sat).connect(this.posSat)
      .connect(this.shelf).connect(ressoMufla).connect(ressoTubo).connect(corteGrave).connect(this.lpMotor);

    // limitador de giro (corte) → flare/tosse → liga/desliga
    this.limite = ganho(1);
    this.profCorte = ganho(0);
    const lfoCorte = ctx.createOscillator();
    lfoCorte.type = 'square'; lfoCorte.frequency.value = 13;
    const suavCorte = filtro('lowpass', 70, 0.6);
    lfoCorte.connect(suavCorte).connect(this.profCorte).connect(this.limite.gain);
    lfoCorte.start();
    this.flare = ganho(1);
    this.gate = ganho(0);
    this.motorCabine = ganho(1);
    this.lpMotor.connect(this.limite).connect(this.flare).connect(this.gate).connect(this.motorCabine).connect(this.busExt);

    // (c) admissão
    this.bpAdm = filtro('bandpass', 800, 1.1);
    const amAdm = ganho(0.65);
    modDisparo.connect(ganho(0.35)).connect(amAdm.gain);
    this.gAdm = ganho(0);
    srcRosa.connect(this.bpAdm).connect(amAdm).connect(this.gAdm).connect(this.limite);

    // ruídos mecânicos: giram mesmo sem combustão
    this.mecanico = ganho(1);
    this.mecanico.connect(this.motorCabine);

    // (d) válvulas
    const hpValv = filtro('highpass', 4200, 0.7);
    const bpValv = filtro('peaking', 7000, 1, 6);
    const amValv = ganho(0.02);
    modValv.connect(ganho(1)).connect(amValv.gain);
    this.gValv = ganho(0);
    srcBranco.connect(hpValv).connect(bpValv).connect(amValv).connect(this.gValv).connect(this.mecanico);

    // compressão sem combustão (girando na partida / morrendo)
    const lpChug = filtro('lowpass', 240, 0.9);
    const amChug = ganho(0.1);
    modDisparo.connect(ganho(1.1)).connect(amChug.gain);
    this.gChug = ganho(0);
    srcMarrom.connect(lpChug).connect(amChug).connect(this.gChug).connect(this.mecanico);

    // motor de partida: zumbido do induzido + chiado das escovas, com a carga da compressão
    this.oscPartida = ctx.createOscillator();
    this.oscPartida.type = 'sawtooth';
    this.oscPartida.frequency.value = 40;
    modDisparo.connect(ganho(9)).connect(this.oscPartida.frequency);
    this.oscPartidaW = ctx.createOscillator();
    this.oscPartidaW.type = 'triangle';
    this.oscPartidaW.frequency.value = 600;
    modDisparo.connect(ganho(110)).connect(this.oscPartidaW.frequency);
    const amPart = ganho(0.6);
    modDisparo.connect(ganho(0.45)).connect(amPart.gain);
    const bpPart = filtro('bandpass', 750, 0.6);
    const hpEscova = filtro('bandpass', 3500, 1.5);
    const gEscova = ganho(0.5);
    this.oscPartida.connect(bpPart).connect(amPart);
    this.oscPartidaW.connect(ganho(0.12)).connect(amPart);
    srcBranco.connect(hpEscova).connect(gEscova).connect(amPart);
    this.gPartida = ganho(0);
    amPart.connect(this.gPartida).connect(this.mecanico);
    this.oscPartida.start();
    this.oscPartidaW.start();

    // câmbio: zumbido de engrenagens (ré de dentes retos bem audível)
    this.oscCambio = ctx.createOscillator();
    this.oscCambio.type = 'sine';
    this.oscCambio.frequency.value = 200;
    this.gCambio = ganho(0);
    this.oscCambio.connect(this.gCambio).connect(this.busExt);
    this.oscCambio.start();

    // ---- pneus e vento ----
    this.lpRua = filtro('lowpass', 200, 0.6);
    this.gRua = ganho(0);
    srcMarrom.connect(this.lpRua).connect(this.gRua).connect(this.busExt);
    const bpBanda = filtro('bandpass', 950, 0.8);
    this.gBanda = ganho(0);
    srcRosa.connect(bpBanda).connect(this.gBanda).connect(this.busExt);

    this.bpCant1 = filtro('bandpass', 950, 16);
    this.bpCant2 = filtro('bandpass', 1420, 22);
    this.oscCant = ctx.createOscillator();
    this.oscCant.type = 'sine';
    this.oscCant.frequency.value = 950;
    const vibr = ganho(220); // cents
    srcLfo1.connect(vibr);
    vibr.connect(this.bpCant1.detune);
    vibr.connect(this.bpCant2.detune);
    vibr.connect(this.oscCant.detune);
    this.gCant = ganho(0);
    const somaCant = ganho(1);
    srcBranco.connect(this.bpCant1).connect(ganho(3.2)).connect(somaCant);
    srcBranco.connect(this.bpCant2).connect(ganho(2.2)).connect(somaCant);
    this.oscCant.connect(ganho(0.12)).connect(somaCant);
    const amCant = ganho(0.75);
    srcLfo2.connect(ganho(0.25)).connect(amCant.gain);
    somaCant.connect(amCant).connect(this.gCant).connect(this.busExt);
    this.oscCant.start();

    // arraste do pneu perto do limite: “rrrr” grave e granulado, antes do cantar
    this.bpArraste = filtro('bandpass', 420, 1.1);
    const lpArraste = filtro('lowpass', 1400, 0.7);
    const amArraste = ganho(0.6);
    srcLfo1.connect(ganho(0.4)).connect(amArraste.gain);
    this.gArraste = ganho(0);
    srcRosa.connect(this.bpArraste).connect(lpArraste).connect(amArraste).connect(this.gArraste).connect(this.busExt);

    this.bpVento = filtro('bandpass', 600, 0.45);
    const hpVento = filtro('highpass', 160, 0.7);
    this.gVento = ganho(0);
    srcRosa.connect(this.bpVento).connect(hpVento).connect(this.gVento).connect(this.busExt);

    const lpFreio = filtro('lowpass', 380, 0.8);
    this.gFreio = ganho(0);
    srcMarrom.connect(lpFreio).connect(this.gFreio).connect(this.busExt);
  }

  /* ---------------- buffers de eventos ---------------- */

  private gerarEventos(ctx: BaseAudioContext): void {
    const sr = ctx.sampleRate;
    const r = prng(97);
    const e = Math.exp;
    const sen = (f: number, t: number) => Math.sin(TAU * f * t);

    // engate: “tlec” metálico + baque da alavanca/coxim
    {
      const bp = new Bq('bp', 1700, 2, sr);
      const bp2 = new Bq('bp', 2600, 4, sr);
      this.buf.marcha = gerar(ctx, 0.16, (t) => {
        const n = r();
        let s = 0.55 * e(-t / 0.022) * sen(92, t) + 0.6 * e(-t / 0.004) * bp.p(n) * 4;
        const t2 = t - 0.032;
        const b2 = bp2.p(n);
        if (t2 > 0) s += 0.35 * e(-t2 / 0.006) * (b2 * 5 + 0.4 * sen(1350, t2));
        return s * 0.8;
      });
    }
    // arranhada: dentes batendo (AM irregular) em ruído metálico
    {
      const bpA = new Bq('bp', 2400, 3, sr);
      const bpB = new Bq('bp', 4100, 5, sr);
      const lp = new Bq('lp', 160, 0.8, sr);
      let fase = 0;
      let porta = 1, proxPorta = 0;
      this.buf.arranhou = gerar(ctx, 0.46, (t) => {
        const n = r();
        fase += (TAU * (150 + 45 * Math.sin(TAU * 3.3 * t) + 20 * r())) / sr;
        const dentes = Math.pow(Math.abs(Math.sin(fase)), 6);
        if (t >= proxPorta) { porta = 0.35 + 0.65 * Math.abs(r()); proxPorta = t + 0.012 + 0.01 * Math.abs(r()); }
        const env = Math.min(1, t / 0.008) * (t > 0.34 ? e(-(t - 0.34) / 0.035) : 1);
        const metal = (bpA.p(n) * 5 + bpB.p(n) * 4) * dentes * porta;
        const ronco = lp.p(Math.sign(Math.sin(TAU * 75 * t)) * 0.6);
        return env * (metal * 0.9 + ronco * 0.5);
      });
    }
    // motor morrendo: 3 tossidas graves, a última com tremedeira da carroceria
    {
      const lp = new Bq('lp', 420, 0.9, sr);
      const bp = new Bq('bp', 650, 2, sr);
      const tossidas: [number, number][] = [[0, 1], [0.12, 0.75], [0.29, 0.5]];
      this.buf.apagou = gerar(ctx, 0.75, (t) => {
        const n = lp.p(r());
        let s = 0;
        for (const [t0, a] of tossidas) {
          const u = t - t0;
          if (u < 0) continue;
          s += a * (0.75 * e(-u / 0.05) * sen(58 - 25 * u, u) + 1.4 * e(-u / 0.03) * n);
        }
        s += 0.15 * e(-Math.max(0, t - 0.3) / 0.12) * (t > 0.3 ? 1 : 0) * bp.p(r()) * 3 * Math.abs(sen(14, t));
        return s * 0.85;
      });
    }
    // freio de mão: catraca (cliques acelerando, tom subindo)
    {
      const hp = new Bq('hp', 2500, 0.7, sr);
      const tempos = [0, 0.06, 0.112, 0.158, 0.199, 0.236, 0.27, 0.301];
      this.buf.freioDeMao = gerar(ctx, 0.36, (t) => {
        const n = hp.p(r());
        let s = 0;
        tempos.forEach((t0, i) => {
          const u = t - t0;
          if (u < 0 || u > 0.05) return;
          const f = 2100 + i * 60;
          s += 0.5 * e(-u / 0.0015) * n + 0.35 * e(-u / 0.01) * sen(f, u) + 0.18 * e(-u / 0.018) * sen(870, u);
        });
        return s * 0.7;
      });
    }
    // cinto: dois estalos metálicos curtos
    {
      const hp = new Bq('hp', 3000, 0.7, sr);
      this.buf.cinto = gerar(ctx, 0.08, (t) => {
        const n = hp.p(r());
        let s = 0;
        for (const [t0, a] of [[0, 0.6], [0.019, 1]] as const) {
          const u = t - t0;
          if (u < 0) continue;
          s += a * (0.5 * e(-u / 0.0008) * n + 0.3 * e(-u / 0.01) * sen(2750, u)
            + 0.2 * e(-u / 0.007) * sen(4350, u) + 0.12 * e(-u / 0.004) * sen(6900, u));
        }
        return s * 0.6;
      });
    }
    // relé da seta: tic / tac
    const rele = (k: number, semente: number) => {
      const rr = prng(semente);
      const hp = new Bq('hp', 2000, 0.7, sr);
      return gerar(ctx, 0.05, (t) => 0.55 * (0.45 * e(-t / 0.0007) * hp.p(rr()) + 0.45 * e(-t / 0.006) * sen(1250 * k, t)
        + 0.25 * e(-t / 0.004) * sen(3300 * k, t) + 0.3 * e(-t / 0.01) * sen(330 * k, t)));
    };
    this.buf.setaTic = rele(1, 5);
    this.buf.setaTac = rele(0.84, 6);
    // meio-fio: baque grave (frequência caindo) + chacoalhada da suspensão
    {
      const lp = new Bq('lp', 300, 0.8, sr);
      const bp = new Bq('bp', 700, 1.5, sr);
      let fase = 0;
      this.buf.meioFio = gerar(ctx, 0.42, (t) => {
        fase += (TAU * (40 + 50 * e(-t / 0.05))) / sr;
        return 0.9 * e(-t / 0.09) * Math.sin(fase) + 1.6 * e(-t / 0.02) * lp.p(r()) + 0.5 * e(-t / 0.08) * bp.p(r());
      });
    }
    // batida: impacto grave, estouro de ruído, ressonâncias de chapa e cacos
    {
      const lp = new Bq('lp', 2800, 0.7, sr);
      const bpM = new Bq('bp', 1200, 1, sr);
      const hpC = new Bq('hp', 4500, 0.7, sr);
      const modos: [number, number][] = [[417, 0.35], [733, 0.5], [1187, 0.6], [1712, 0.42], [2333, 0.3], [3170, 0.22]];
      const cacos = Array.from({ length: 14 }, () => [0.05 + 0.85 * Math.abs(r()), 0.1 + 0.25 * Math.abs(r())] as const);
      let fase = 0;
      this.buf.batida = gerar(ctx, 1.4, (t) => {
        const n = r();
        fase += (TAU * (38 + 45 * e(-t / 0.06))) / sr;
        let s = 1.0 * e(-t / 0.09) * Math.sin(fase);
        s += 1.4 * e(-t / 0.11) * lp.p(n) + 0.9 * e(-t / 0.25) * bpM.p(n);
        const ata = Math.min(1, t / 0.002);
        for (const [f, d] of modos) s += 0.07 * ata * e(-t / d) * sen(f, t);
        const c = hpC.p(n);
        for (const [t0, a] of cacos) {
          const u = t - t0;
          if (u > 0 && u < 0.03) s += a * e(-u / 0.005) * c * 3;
        }
        return s * 0.7;
      });
    }
    // estalo de escapamento em desaceleração
    {
      const bp = new Bq('bp', 900, 1, sr);
      this.buf.estalo = gerar(ctx, 0.05, (t) => 1.6 * e(-t / 0.006) * bp.p(r()) + 0.5 * e(-t / 0.012) * sen(130, t));
    }
    // bomba de combustível pressurizando ao ligar a chave
    {
      const lp = new Bq('lp', 900, 0.8, sr);
      const bp = new Bq('bp', 2400, 3, sr);
      let fase = 0;
      this.buf.bomba = gerar(ctx, 1.8, (t) => {
        fase += (160 + 25 * Math.min(1, t / 1.2) + 3 * Math.sin(TAU * 9 * t)) / sr;
        const saw = 2 * (fase - Math.floor(fase)) - 1;
        const env = Math.min(1, t / 0.06) * (t > 1.55 ? e(-(t - 1.55) / 0.06) : 1) * (1 - 0.3 * Math.min(1, t / 1.5));
        return env * (0.5 * lp.p(saw) + 0.6 * bp.p(r()));
      });
    }
  }

  private tocar(b: AudioBuffer | undefined, destino: AudioNode, g: number, taxa = 1, quando = 0): AudioBufferSourceNode | null {
    const ctx = this.ctx;
    if (!ctx || !b || g <= 0) return null;
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.playbackRate.value = taxa;
    const gn = ctx.createGain();
    gn.gain.value = g;
    s.connect(gn).connect(destino);
    s.start(ctx.currentTime + quando);
    s.onended = () => gn.disconnect();
    return s;
  }

  /* ---------------- por quadro ---------------- */

  atualizar(dt: number, e: EstadoSom): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const alvo = (p: AudioParam, v: number, tau: number) => {
      if (Number.isFinite(v)) p.setTargetAtTime(v, t, tau);
    };

    const r = clamp(Math.abs(e.rpm), 0, 9000);
    const c = clamp(e.carga, 0, 1);
    const lig = e.ligado;
    const giro = clamp(r / 6000, 0, 1.2);
    const fCiclo = r / 120;

    alvo(this.freqCiclo.offset, fCiclo, 0.012);

    // lenta irregular: alguns % de rpm e de amplitude
    const lenta = lig ? 1 - suave(this.rpmLenta + 150, this.rpmLenta + 900, r) : 0;
    alvo(this.jitterFreq.gain, fCiclo * 0.035 * lenta, 0.1);

    // timbre pela carga
    const emCarga = suave(0.03, 0.55, c);
    const nivel = 0.2 + 0.28 * giro;
    alvo(this.gA.gain, nivel * (0.3 + 0.8 * emCarga), 0.04);
    alvo(this.jitterAmp.gain, nivel * 0.18 * lenta, 0.1);
    alvo(this.gB.gain, nivel * 0.55 * (1 - emCarga) * (0.55 + 0.6 * giro), 0.05);
    alvo(this.gEsc.gain, (0.05 + 0.5 * emCarga) * (0.45 + giro), 0.05);
    const fDisparo = r / 30;
    alvo(this.bpEsc.frequency, clamp(fDisparo * 2, 50, 2500), 0.03);
    alvo(this.bpEsc2.frequency, clamp(fDisparo * 6, 150, 5000), 0.03);
    alvo(this.preSat.gain, 0.7 + 1.6 * emCarga, 0.05);
    alvo(this.posSat.gain, 1 / (1 + 0.8 * emCarga), 0.05);
    alvo(this.shelf.gain, 1 + 6 * emCarga, 0.05);
    alvo(this.lpMotor.frequency, 1100 + r * 0.9 + 600 * emCarga, 0.05);
    alvo(this.gAdm.gain, (lig ? 0.008 : 0) + 0.2 * c * Math.pow(giro, 1.2), 0.05);
    alvo(this.bpAdm.frequency, 450 + r * 0.35, 0.05);
    alvo(this.gValv.gain, (0.005 + 0.016 * giro) * clamp(r / 300, 0, 1), 0.05);

    alvo(this.gate.gain, lig ? 1 : 0, lig ? 0.03 : 0.08);

    // limitador: corte em rajadas
    const noCorte = lig && r > this.rpmCorte - 150;
    if (noCorte) this.corteAtivo = 0.25; else this.corteAtivo = Math.max(0, this.corteAtivo - dt);
    const corte = this.corteAtivo > 0;
    alvo(this.limite.gain, corte ? 0.5 : 1, 0.01);
    alvo(this.profCorte.gain, corte ? 0.5 : 0, 0.01);

    // sem combustão: compressão + motor de partida
    const girando = clamp(r / 200, 0, 1);
    alvo(this.gChug.gain, lig ? 0 : 0.5 * girando, 0.04);
    const arrancando = e.partida && !lig && e.ignicao;
    alvo(this.gPartida.gain, arrancando ? 0.13 : 0, arrancando ? 0.015 : 0.06);
    alvo(this.oscPartida.frequency, 28 + r * 0.17, 0.03);
    alvo(this.oscPartidaW.frequency, 380 + r * 2.2, 0.03);

    // estalos em overrun (sutis)
    if (lig && c < 0.02 && r > 2300 && Math.random() < dt * 3.5 * giro) {
      this.tocar(this.buf.estalo, this.motorCabine, 0.05 + 0.08 * Math.random(), 0.8 + 0.5 * Math.random());
    }

    // bomba de combustível ao ligar a chave
    if (e.ignicao && !this.ignicaoAntes && !lig) this.tocar(this.buf.bomba, this.busInt, 0.05);
    this.ignicaoAntes = e.ignicao;

    // câmbio
    const v = Math.abs(e.velocidade);
    if (e.marcha === -1) {
      alvo(this.oscCambio.frequency, 40 + v * 110, 0.05);
      alvo(this.gCambio.gain, 0.045 * clamp(v / 1.5, 0, 1) * (1 - 0.6 * e.embreagem), 0.05);
    } else {
      const engatado = e.marcha !== 0 && e.embreagem < 0.6;
      alvo(this.oscCambio.frequency, Math.max(20, (r / 60) * 17), 0.03);
      alvo(this.gCambio.gain, engatado ? 0.005 * (0.4 + c) * clamp(v / 3, 0, 1) : 0, 0.06);
    }

    // pneus e vento
    const vr = clamp(v / 30, 0, 1.4);
    alvo(this.gRua.gain, 0.32 * Math.pow(vr, 0.85), 0.08);
    alvo(this.lpRua.frequency, 110 + v * 22, 0.08);
    alvo(this.gBanda.gain, 0.035 * vr, 0.08);
    const s = clamp((e.escorregamento - 1) / 3, 0, 1);
    alvo(this.gCant.gain, 0.32 * Math.pow(s, 1.3), 0.04);
    const fCant = 860 + 260 * clamp(e.escorregamento / 7, 0, 1);
    alvo(this.bpCant1.frequency, fCant, 0.05);
    alvo(this.bpCant2.frequency, fCant * 1.49, 0.05);
    alvo(this.oscCant.frequency, fCant, 0.05);
    const uso = clamp(e.aderencia ?? 0, 0, 1);
    const arraste = suave(0.65, 0.97, uso) * clamp((v - 2) / 8, 0, 1);
    alvo(this.gArraste.gain, 0.22 * arraste, 0.06);
    alvo(this.bpArraste.frequency, 320 + 9 * v + 200 * suave(0.85, 1, uso), 0.08);
    alvo(this.gVento.gain, Math.min(0.35, 0.00032 * v * v), 0.1);
    alvo(this.bpVento.frequency, 450 + v * 12, 0.1);
    alvo(this.gFreio.gain, 0.05 * clamp(e.freio, 0, 1) * clamp(v / 4, 0, 1) * clamp(1.5 - v / 20, 0, 1), 0.05);

    // dentro x fora
    alvo(this.filtroCabine.frequency, e.cockpit ? 4200 : 16000, 0.12);
    alvo(this.boomCabine.gain, e.cockpit ? 4 : 0, 0.12);
    alvo(this.motorCabine.gain, e.cockpit ? 0.8 : 1, 0.12);
    alvo(this.busInt.gain, e.cockpit ? 1 : 0.3, 0.12);
  }

  /* ---------------- eventos ---------------- */

  evento(ev: EventoSom, intensidade = 1): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const i = clamp(intensidade, 0, 1);
    const varia = () => 0.96 + 0.08 * Math.random();
    switch (ev) {
      case 'marcha':
        this.tocar(this.buf.marcha, this.busInt, 0.35, varia());
        break;
      case 'arranhou':
        this.tocar(this.buf.arranhou, this.busInt, 0.3, varia());
        break;
      case 'freioDeMao':
        this.tocar(this.buf.freioDeMao, this.busInt, 0.22, varia());
        break;
      case 'cinto':
        this.tocar(this.buf.cinto, this.busInt, 0.16, varia());
        break;
      case 'seta':
        this.setaAlterna = !this.setaAlterna;
        this.tocar(this.setaAlterna ? this.buf.setaTic : this.buf.setaTac, this.busInt, 0.12);
        break;
      case 'meioFio':
        this.tocar(this.buf.meioFio, this.busExt, 0.12 + 0.5 * i, 0.9 + 0.2 * Math.random());
        break;
      case 'batida': {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 700 + 12000 * i * i;
        lp.connect(this.busExt);
        const s = this.tocar(this.buf.batida, lp, 0.25 + 0.75 * i, 0.9 + 0.15 * Math.random());
        if (s) s.addEventListener('ended', () => lp.disconnect());
        break;
      }
      case 'pegou': {
        // o motor “explode” acima da lenta antes do controle segurar
        const p = this.flare.gain;
        p.cancelScheduledValues(t);
        p.setValueAtTime(1, t);
        p.linearRampToValueAtTime(1.7, t + 0.07);
        p.setTargetAtTime(1, t + 0.12, 0.25);
        this.tocar(this.buf.estalo, this.motorCabine, 0.12, 0.6);
        this.tocar(this.buf.setaTac, this.mecanico, 0.08, 0.5); // pinhão do motor de partida desacoplando
        break;
      }
      case 'apagou': {
        this.tocar(this.buf.apagou, this.motorCabine, 0.5);
        const p = this.flare.gain;
        p.cancelScheduledValues(t);
        p.setValueAtTime(1, t);
        const tremor = [0.3, 1.25, 0.2, 1.05, 0.15];
        tremor.forEach((v, k) => p.linearRampToValueAtTime(v, t + 0.04 * (k + 1)));
        p.setTargetAtTime(1, t + 0.25, 0.3);
        break;
      }
    }
  }
}
