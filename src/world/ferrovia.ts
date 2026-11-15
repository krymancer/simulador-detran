import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Simulacao } from '../sim/simulation';
import { ALTURA_CALCADA, lerGrade, METROS_POR_PX, px } from './autoescola';
import grade from './autoescola/grade.json';

/**
 * Ferrovia com passagem de nível na rua de baixo da pista da autoescola.
 *
 * Linha reta norte–sul em x = 678 px da planta (a linha escura entre os dois
 * “X” pintados). Vem do sul, de fora do mapa (~170 m além da borda), cruza a
 * rua de baixo (asfalto entre y = 1192 e 1360 px) e termina numa parada com
 * para-choque dentro do canteiro grande ao norte (y ≈ 528 px).
 *
 * Um trem de ida e volta (locomotiva diesel de 14 m + carro de passageiros
 * de 10,8 m) faz: garagem (fora do mapa) → ida até a plataforma → espera →
 * volta à garagem → intervalo. O movimento de cada perna é planejado uma vez
 * (perfil de velocidade com aceleração/frenagem suaves) e tabelado no tempo,
 * então o passo da física só interpola. Isso também dá o tempo exato até o
 * trem chegar à passagem, usado para ligar o alerta 25 s antes.
 *
 * Física:
 *  - Locomotiva e carro: corpos cinemáticos (cuboides). O carro do jogador é
 *    dinâmico, então é parado/empurrado, nunca atravessa.
 *  - Cancelas: corpo cinemático com um cuboide fino, habilitado só quando a
 *    cancela está abaixada. Devagar (< 1,5 m/s) o carro esbarra e para; mais
 *    rápido, a cancela QUEBRA (o colisor é desligado antes do contato, a ponta
 *    do braço some) e `cancelaQuebrada` fica true até `reiniciar()`.
 *    Se o carro estiver embaixo do braço, a cancela não desce sobre ele.
 *  - Contato com o trem é detectado geometricamente (retângulos no plano) e
 *    gera 'colisao_trem' uma vez por episódio.
 *
 * Tudo roda sem DOM com `{ visuais: false }` (testes). O grupo visual está em
 * coordenadas de mundo: adicione `grupo` direto na cena.
 */

export type EstadoPassagem = 'livre' | 'alerta' | 'fechada';

export interface OpcoesFerrovia {
  /** Cria as malhas (padrão true). Nos testes: false. */
  visuais?: boolean;
  /** Segundos entre viagens (trem parado na garagem). Padrão 90. */
  intervalo?: number;
  /** Semente do sorteio (variação do intervalo e da espera na estação). */
  semente?: number;
}

// ---------------------------------------------------------------- geometria (planta → mundo)

/** x da linha na planta (px). */
const X_LINHA_PX = 678;
/** Bordas da rua de baixo na planta (meio-fio norte / sul). */
const Y_RUA_NORTE_PX = 1192;
const Y_RUA_SUL_PX = 1360;
/** Para-choque da estação (fim da linha ao norte). */
const Y_PARA_CHOQUE_PX = 528;

const XT = px(X_LINHA_PX, 0).x; // x da linha no mundo
const Z_N = px(0, Y_RUA_NORTE_PX).z; // meio-fio norte da rua
const Z_S = px(0, Y_RUA_SUL_PX).z; // meio-fio sul da rua
const Z_RUA = (Z_N + Z_S) / 2;
const Z_PARA_CHOQUE = px(0, Y_PARA_CHOQUE_PX).z;
const Z_BORDA_SUL_PLANTA = px(0, grade.alturaPx).z;
/** Fim da linha ao sul (fora do mapa). */
const Z_FIM_SUL = Z_BORDA_SUL_PLANTA + 172;

/** Bitola larga brasileira (1,60 m): eixo de cada trilho a ±0,8 m. */
const MEIA_BITOLA = 0.8;
/** Meia largura do gabarito do trem (m). */
const MEIA_LARG_TREM = 1.45;
/** Meia largura do corredor da linha (gabarito + folga), exportada em `cruzamento`. */
const MEIA_LARG_CORREDOR = 1.6;

/** Topo do trilho: no asfalto, rente; nos canteiros, sobre lastro e dormentes. */
const R_VIA = 0.012;
const R_MEIO_FIO = 0.18;
const R_LASTRO = 0.48;
const RAMPA_CANTEIRO = 10; // m para subir do meio-fio até a altura do lastro
const RAMPA_RUA = 0.5; // m de concreto inclinado junto a cada meio-fio
const PERFIL: [number, number][] = [
  [Z_PARA_CHOQUE - 20, R_LASTRO],
  [Z_N - RAMPA_CANTEIRO, R_LASTRO],
  [Z_N, R_MEIO_FIO],
  [Z_N + RAMPA_RUA, R_VIA],
  [Z_S - RAMPA_RUA, R_VIA],
  [Z_S, R_MEIO_FIO],
  [Z_S + RAMPA_CANTEIRO, R_LASTRO],
  [Z_FIM_SUL + 20, R_LASTRO],
];

/** Altura do topo do trilho em z. */
function alturaTrilho(z: number): number {
  if (z <= PERFIL[0][0]) return PERFIL[0][1];
  for (let i = 1; i < PERFIL.length; i++) {
    const [z1, r1] = PERFIL[i];
    if (z <= z1) {
      const [z0, r0] = PERFIL[i - 1];
      return r0 + ((r1 - r0) * (z - z0)) / (z1 - z0);
    }
  }
  return PERFIL[PERFIL.length - 1][1];
}

// ---------------------------------------------------------------- composição

const COMP_LOCO = 14;
const COMP_CARRO = 10.8;
const FOLGA_ENGATE = 0.8;
/** Comprimento total do trem (frente da locomotiva ao fim do carro). */
const COMP_TREM = COMP_LOCO + FOLGA_ENGATE + COMP_CARRO;

interface Veiculo {
  /** distância da frente do trem ao centro do veículo */
  desloc: number;
  meioComp: number;
  /** distância (do centro) aos centros dos truques */
  truque: number;
  raioRoda: number;
  eixos: number[]; // posições dos eixos relativas ao centro do truque
  alturaColisor: [number, number]; // de/até (acima do trilho)
}

const LOCO: Veiculo = {
  desloc: COMP_LOCO / 2, meioComp: COMP_LOCO / 2, truque: 4.4, raioRoda: 0.5,
  eixos: [-1.85, 0, 1.85], alturaColisor: [0.3, 4.15],
};
const CARRO: Veiculo = {
  desloc: COMP_LOCO + FOLGA_ENGATE + COMP_CARRO / 2, meioComp: COMP_CARRO / 2, truque: 3.6, raioRoda: 0.42,
  eixos: [-1.1, 1.1], alturaColisor: [0.3, 3.95],
};
const VEICULOS = [LOCO, CARRO];

// ---------------------------------------------------------------- operação

/** Parada na estação: frente do trem a 0,8 m do para-choque. */
const Z_PARADA = Z_PARA_CHOQUE + 0.8;
/** Garagem: frente do trem bem ao sul, fora do mapa. */
const Z_GARAGEM = Z_FIM_SUL - COMP_TREM - 4;
const V_CRUZEIRO = 40 / 3.6;
const V_PASSAGEM = 30 / 3.6;
const JANELA_LENTA = 25; // m antes da rua em que o trem já está na velocidade da passagem
const A_ACEL = 0.7;
const A_FREIO = 0.6;
const ANTECEDENCIA = 25; // s de alerta antes de o trem chegar à rua
const ATRASO_CANCELA = 6; // s entre as luzes acenderem e a cancela começar a descer
const T_DESCER = 6; // s para descer
const T_SUBIR = 4.5; // s para subir
const ESPERA_ESTACAO = 15; // s parado com portas abertas
const MARGEM_OCUPA = 0.5; // m além do meio-fio que já conta como “na passagem”
const V_QUEBRA = 1.5; // m/s: acima disso o carro quebra a cancela

/** Cancela: pivô e direção do braço (+1: para +z; −1: para −z). */
interface DefCancela {
  pivo: THREE.Vector3;
  sentido: 1 | -1;
  comp: number;
  /** de onde vêm os motoristas que ela barra (sinal de x) */
  ladoX: 1 | -1;
}
const ALT_PIVO = 1.0; // acima da calçada
const DEF_CANCELAS: DefCancela[] = [
  // mão para leste (faixa sul): vêm do oeste, cancela na calçada sul, braço para o norte
  { pivo: new THREE.Vector3(XT - 4.3, ALTURA_CALCADA + ALT_PIVO, Z_S + 0.55), sentido: -1, comp: 3.95, ladoX: -1 },
  // mão para oeste (faixa norte): vêm do leste, cancela na calçada norte, braço para o sul
  { pivo: new THREE.Vector3(XT + 4.3, ALTURA_CALCADA + ALT_PIVO, Z_N - 0.55), sentido: 1, comp: 3.95, ladoX: 1 },
];
/** Mastros com Cruz de Santo André e luzes, ao lado de cada cancela (mais perto da linha). */
const DEF_MASTROS = DEF_CANCELAS.map((c) => ({
  pos: new THREE.Vector3(XT + c.ladoX * 3.4, ALTURA_CALCADA, c.pivo.z),
  ladoX: c.ladoX,
}));

/**
 * Placas A-40 (passagem de nível com barreira) ~40 m antes, medidos pelo
 * caminho: a rua de baixo é curta, então ficam nas pistas que levam a ela.
 * face = direção (planta) de onde vêm os motoristas.
 */
export const PLACAS_FERROVIA_PX: { x: number; y: number; face: [number, number] }[] = [
  { x: 42, y: 930, face: [0, -1] }, // anel esquerdo, descendo (vai virar para leste na rua de baixo)
  { x: 1372, y: 1080, face: [0, -1] }, // anel direito, descendo (vai virar para oeste na rua de baixo)
];

/** Plataforma (lado oeste da linha). */
const PLAT = {
  x0: XT - MEIA_LARG_TREM - 0.2 - 3.4,
  x1: XT - MEIA_LARG_TREM - 0.2,
  z0: Z_PARADA - 0.5,
  z1: Z_N - 5,
  topo: ALTURA_CALCADA + 1.2,
};

/**
 * Áreas da planta (px) que precisam ficar sem árvores/prédios: o corredor da
 * linha (de y = 400 até a borda sul) e a estação (plataforma + rampa).
 * Fora da planta, deixe livre a faixa de mundo `CORREDOR_FERROVIA` em x.
 */
export const AREAS_LIVRES_FERROVIA_PX: { x0: number; x1: number; y0: number; y1: number }[] = [
  { x0: 640, x1: 716, y0: 400, y1: grade.alturaPx },
  {
    x0: Math.floor(PLAT.x0 / METROS_POR_PX + grade.larguraPx / 2) - 12,
    x1: 640,
    y0: Math.floor((PLAT.z0 - 7.5) / METROS_POR_PX + grade.alturaPx / 2),
    y1: Math.ceil(PLAT.z1 / METROS_POR_PX + grade.alturaPx / 2) + 12,
  },
];
/** Faixa em x (mundo) que a linha ocupa ao sul da planta (até `zFim`). */
export const CORREDOR_FERROVIA = { xMin: XT - 3, xMax: XT + 3, zFim: Z_FIM_SUL + 2 };

// ---------------------------------------------------------------- planejamento das pernas

interface Perna {
  zIni: number;
  zFim: number;
  dtTab: number;
  /** z da frente do trem em t = k·dtTab */
  z: Float32Array;
  v: Float32Array;
  dur: number;
  /** tempo até o trem entrar na faixa da rua */
  tChega: number;
  /** tempo em que o trem termina de sair da faixa da rua */
  tLibera: number;
}

function ocupa(zFrente: number): boolean {
  return zFrente < Z_S + MARGEM_OCUPA && zFrente + COMP_TREM > Z_N - MARGEM_OCUPA;
}

function planejarPerna(zIni: number, zFim: number): Perna {
  const dir = Math.sign(zFim - zIni);
  const D = Math.abs(zFim - zIni);
  const h = 0.05;
  const n = Math.ceil(D / h) + 1;
  const dh = D / (n - 1);
  const v = new Float64Array(n);
  // janela lenta só do lado de onde o trem vem
  const j0 = dir < 0 ? Z_N - MARGEM_OCUPA : Z_N - JANELA_LENTA;
  const j1 = dir < 0 ? Z_S + JANELA_LENTA : Z_S + MARGEM_OCUPA;
  for (let i = 0; i < n; i++) {
    const zf = zIni + dir * i * dh;
    const lento = zf < j1 && zf + COMP_TREM > j0;
    v[i] = lento ? V_PASSAGEM : V_CRUZEIRO;
  }
  v[0] = 0;
  v[n - 1] = 0;
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * A_FREIO * dh));
  for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * A_ACEL * dh));
  const t = new Float64Array(n);
  for (let i = 1; i < n; i++) t[i] = t[i - 1] + (2 * dh) / Math.max(1e-3, v[i - 1] + v[i]);
  const dur = t[n - 1];
  let tChega = Infinity, tLibera = 0;
  for (let i = 0; i < n; i++) {
    if (ocupa(zIni + dir * i * dh)) {
      if (tChega === Infinity) tChega = t[i];
      tLibera = t[i];
    }
  }
  const dtTab = 0.02;
  const m = Math.ceil(dur / dtTab) + 1;
  const zt = new Float32Array(m);
  const vt = new Float32Array(m);
  let i = 0;
  for (let k = 0; k < m; k++) {
    const tk = Math.min(dur, k * dtTab);
    while (i < n - 2 && t[i + 1] < tk) i++;
    const f = Math.min(1, Math.max(0, (tk - t[i]) / (t[i + 1] - t[i] || 1e-9)));
    zt[k] = zIni + dir * (i + f) * dh;
    vt[k] = v[i] + (v[i + 1] - v[i]) * f;
  }
  return { zIni, zFim, dtTab, z: zt, v: vt, dur, tChega, tLibera };
}

function amostrar(p: Perna, t: number, out: { z: number; v: number }): void {
  const x = Math.min(p.z.length - 1, Math.max(0, t / p.dtTab));
  const k = Math.min(p.z.length - 2, Math.floor(x));
  const f = Math.min(1, x - k);
  out.z = p.z[k] + (p.z[k + 1] - p.z[k]) * f;
  out.v = p.v[k] + (p.v[k + 1] - p.v[k]) * f;
}

// ---------------------------------------------------------------- utilidades

function criarSorteio(semente: number): () => number {
  let a = semente >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Separação (plano XZ) entre um retângulo orientado (carro) e um alinhado aos eixos. */
function separacaoCarroCaixa(
  cx: number, cz: number, yaw: number, hw: number, hl: number,
  bx: number, bz: number, bhx: number, bhz: number,
): number {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const dx = bx - cx, dz = bz - cz;
  let sep = -Infinity;
  const eixos = [[fx, fz], [fz, -fx], [1, 0], [0, 1]];
  for (const [ux, uz] of eixos) {
    const ra = hl * Math.abs(fx * ux + fz * uz) + hw * Math.abs(fz * ux - fx * uz);
    const rb = bhx * Math.abs(ux) + bhz * Math.abs(uz);
    const s = Math.abs(dx * ux + dz * uz) - ra - rb;
    if (s > sep) sep = s;
  }
  return sep;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _amostra = { z: 0, v: 0 };

type Fase = 'garagem' | 'ida' | 'estacao' | 'volta';

interface PoseVeiculo {
  x: number; y: number; z: number; pitch: number;
}

interface CancelaFisica {
  def: DefCancela;
  /** ângulo do braço: 0 = abaixado (horizontal), π/2 = levantado */
  ang: number;
  quebrada: boolean;
  corpo: RAPIER.RigidBody;
  colisor: RAPIER.Collider;
  colisorLigado: boolean;
}

// ---------------------------------------------------------------- classe

export class Ferrovia {
  readonly grupo = new THREE.Group();
  readonly cruzamento: { centro: THREE.Vector3; meiaLarguraTrilhos: number } = {
    centro: new THREE.Vector3(XT, 0, Z_RUA),
    meiaLarguraTrilhos: MEIA_LARG_CORREDOR,
  };

  private readonly sim: Simulacao;
  private readonly visuais: boolean;
  private readonly intervalo: number;
  private sorteio: () => number;
  private readonly semente: number;
  private readonly ida = planejarPerna(Z_GARAGEM, Z_PARADA);
  private readonly volta = planejarPerna(Z_PARADA, Z_GARAGEM);

  private fase: Fase = 'garagem';
  private timer = 0;
  private tPerna = 0;
  private zFrente = Z_GARAGEM;
  private vTrem = 0;
  private sentido: -1 | 0 | 1 = 0; // −1 indo para o norte (ida), +1 voltando
  private percorrido = 0;
  private alarme = false;
  private tAlarme = 0;
  private _estado: EstadoPassagem = 'livre';
  private _buzina = false;
  private colidiu = false;
  private contatoTrem = false;
  private readonly fila: 'colisao_trem'[] = [];

  private readonly corposTrem: RAPIER.RigidBody[] = [];
  private readonly poses: PoseVeiculo[] = VEICULOS.map(() => ({ x: XT, y: 0, z: 0, pitch: 0 }));
  private readonly cancelas: CancelaFisica[] = [];

  private visual: VisualFerrovia | null = null;
  private tVisual = 0;

  constructor(sim: Simulacao, opcoes: OpcoesFerrovia = {}) {
    this.sim = sim;
    this.visuais = opcoes.visuais ?? true;
    this.intervalo = opcoes.intervalo ?? 90;
    this.semente = opcoes.semente ?? 20261115;
    this.sorteio = criarSorteio(this.semente);
    this.grupo.name = 'ferrovia';

    for (const v of VEICULOS) {
      const corpo = sim.mundo.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      const [y0, y1] = v.alturaColisor;
      sim.mundo.createCollider(
        RAPIER.ColliderDesc.cuboid(MEIA_LARG_TREM, (y1 - y0) / 2, v.meioComp)
          .setTranslation(0, (y0 + y1) / 2, 0)
          .setFriction(0.5)
          .setRestitution(0.05),
        corpo,
      );
      this.corposTrem.push(corpo);
    }
    for (const def of DEF_CANCELAS) {
      const corpo = sim.mundo.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(def.pivo.x, def.pivo.y, def.pivo.z),
      );
      const colisor = sim.mundo.createCollider(
        RAPIER.ColliderDesc.cuboid(0.05, 0.05, def.comp / 2).setTranslation(0, 0, (def.sentido * def.comp) / 2).setFriction(0.3),
        corpo,
      );
      colisor.setEnabled(false);
      this.cancelas.push({ def, ang: Math.PI / 2, quebrada: false, corpo, colisor, colisorLigado: false });
    }

    if (this.visuais) {
      this.visual = criarVisual();
      this.grupo.add(this.visual.raiz);
    }
    this.reiniciar();
  }

  // ------------------------------------------------------------ API

  get estado(): EstadoPassagem {
    return this._estado;
  }

  get sinoTocando(): boolean {
    return this._estado !== 'livre';
  }

  /** O trem está buzinando (aproximação da passagem e partida). */
  get buzinaTocando(): boolean {
    return this._buzina;
  }

  /** Alguma cancela foi quebrada pelo carro do jogador neste episódio. */
  get cancelaQuebrada(): boolean {
    return this.cancelas.some((c) => c.quebrada);
  }

  /** Estado do trem: z da frente (norte) e da traseira, velocidade (m/s, + = para o sul). */
  estadoTrem(): { zFrente: number; zTras: number; x: number; velocidade: number; fase: Fase } {
    return { zFrente: this.zFrente, zTras: this.zFrente + COMP_TREM, x: XT, velocidade: this.vTrem * this.sentido + 0, fase: this.fase };
  }

  eventos(): 'colisao_trem'[] {
    return this.fila.splice(0);
  }

  reiniciar(): void {
    this.fila.length = 0;
    this.colidiu = false;
    this.contatoTrem = false;
    // reinicia o sorteio para o episódio ser reprodutível
    this.sorteio = criarSorteio(this.semente);
    this.fase = 'garagem';
    this.timer = this.sortearIntervalo();
    this.tPerna = 0;
    this.zFrente = Z_GARAGEM;
    this.vTrem = 0;
    this.sentido = 0;
    this.alarme = false;
    this.tAlarme = 0;
    this._buzina = false;
    for (const c of this.cancelas) {
      c.ang = Math.PI / 2;
      c.quebrada = false;
      this.ligarColisor(c, false);
    }
    this.posicionarTrem(true);
    this.posicionarCancelas(true);
    this._estado = 'livre';
  }

  liberar(): void {
    for (const c of this.corposTrem) this.sim.mundo.removeRigidBody(c);
    for (const c of this.cancelas) this.sim.mundo.removeRigidBody(c.corpo);
    this.corposTrem.length = 0;
    this.cancelas.length = 0;
    this.grupo.removeFromParent();
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    this.grupo.traverse((o) => {
      const m = o as THREE.Mesh;
      const sprite = (o as THREE.Sprite).isSprite;
      if (!m.isMesh && !sprite) return;
      if (m.geometry && !sprite) geos.add(m.geometry); // a geometria do Sprite é compartilhada pelo three
      for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x);
    });
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    });
    this.grupo.clear();
    cacheMat.clear();
    _texBrilho = null;
    this.visual = null;
  }

  // ------------------------------------------------------------ passo da física

  passo(dt: number): void {
    if (!this.corposTrem.length) return;
    this.avancarTrem(dt);
    this.posicionarTrem(false);

    // alerta: trem na passagem ou chegando em ≤ 25 s
    const ocupando = ocupa(this.zFrente);
    const alarme = ocupando || this.eta() <= ANTECEDENCIA;
    if (alarme && !this.alarme) this.tAlarme = 0;
    this.alarme = alarme;
    if (alarme) this.tAlarme += dt;

    const jog = this.lerJogador();
    this.passoCancelas(dt, jog);
    this.posicionarCancelas(false);
    this.verificarContatoTrem(jog);

    const todasAbaixadas = this.cancelas.every((c) => c.quebrada || c.ang <= 0.02);
    const todasLevantadas = this.cancelas.every((c) => c.quebrada || c.ang >= Math.PI / 2 - 0.01);
    if (ocupando || (alarme && todasAbaixadas)) this._estado = 'fechada';
    else if (!alarme && todasLevantadas) this._estado = 'livre';
    else this._estado = 'alerta';
  }

  private sortearIntervalo(): number {
    return this.intervalo * (0.85 + 0.3 * this.sorteio());
  }

  /** Tempo (s) até o trem entrar na faixa da rua; Infinity se já passou nesta perna. */
  private eta(): number {
    switch (this.fase) {
      case 'garagem': return this.timer + this.ida.tChega;
      case 'estacao': return this.timer + this.volta.tChega;
      case 'ida': return this.tPerna <= this.ida.tLibera ? this.ida.tChega - this.tPerna : Infinity;
      case 'volta': return this.tPerna <= this.volta.tLibera ? this.volta.tChega - this.tPerna : Infinity;
    }
  }

  private avancarTrem(dt: number): void {
    const z0 = this.zFrente;
    if (this.fase === 'garagem' || this.fase === 'estacao') {
      this.timer -= dt;
      this.vTrem = 0;
      // toque curto de buzina antes de partir
      this._buzina = this.timer > 0 && this.timer < 1.2;
      if (this.timer <= 0) {
        this.fase = this.fase === 'garagem' ? 'ida' : 'volta';
        this.tPerna = 0;
        this.sentido = this.fase === 'ida' ? -1 : 1;
      }
    } else {
      const p = this.fase === 'ida' ? this.ida : this.volta;
      this.tPerna += dt;
      amostrar(p, this.tPerna, _amostra);
      this.zFrente = _amostra.z;
      this.vTrem = _amostra.v;
      // buzina: dois toques ao se aproximar da passagem
      const eta = p.tChega - this.tPerna;
      this._buzina = (eta > 8 && eta < 11) || (eta > 2.5 && eta < 5.5);
      if (this.tPerna >= p.dur) {
        this.zFrente = p.zFim;
        this.vTrem = 0;
        this._buzina = false;
        if (this.fase === 'ida') {
          this.fase = 'estacao';
          // espera com portas abertas + o que faltar para dar 25 s de alerta antes de cruzar
          const espera = ESPERA_ESTACAO * (0.9 + 0.2 * this.sorteio());
          this.timer = espera + Math.max(0, ANTECEDENCIA - this.volta.tChega);
        } else {
          this.fase = 'garagem';
          this.timer = this.sortearIntervalo();
        }
      }
    }
    this.percorrido += Math.abs(this.zFrente - z0);
  }

  private posicionarTrem(teleporte: boolean): void {
    VEICULOS.forEach((v, i) => {
      const zc = this.zFrente + v.desloc;
      const za = zc - v.truque, zb = zc + v.truque;
      let ya = 0, yb = 0;
      for (const e of v.eixos) { ya += alturaTrilho(za + e); yb += alturaTrilho(zb + e); }
      ya /= v.eixos.length;
      yb /= v.eixos.length;
      const pose = this.poses[i];
      pose.x = XT;
      pose.y = (ya + yb) / 2;
      pose.z = zc;
      pose.pitch = -Math.atan2(yb - ya, zb - za);
      const corpo = this.corposTrem[i];
      if (!corpo) return;
      _q.setFromEuler(_e.set(pose.pitch, 0, 0));
      if (teleporte) {
        corpo.setTranslation({ x: pose.x, y: pose.y, z: pose.z }, true);
        corpo.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
      } else {
        corpo.setNextKinematicTranslation({ x: pose.x, y: pose.y, z: pose.z });
        corpo.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
      }
    });
  }

  // ------------------------------------------------------------ jogador

  private lerJogador(): { x: number; z: number; yaw: number; hw: number; hl: number; vx: number; vz: number; y: number } {
    const col = this.sim.carro.colisor;
    const t = col.translation();
    const r = col.rotation();
    const yaw = Math.atan2(2 * (r.x * r.z + r.w * r.y), 1 - 2 * (r.x * r.x + r.y * r.y));
    const cb = this.sim.carro.cfg.carroceria;
    const lv = this.sim.carro.corpo.linvel();
    return { x: t.x, y: t.y, z: t.z, yaw, hw: cb.meiaLargura, hl: cb.meiaComprimento, vx: lv.x, vz: lv.z };
  }

  private verificarContatoTrem(j: ReturnType<Ferrovia['lerJogador']>): void {
    let sep = Infinity;
    for (let i = 0; i < VEICULOS.length; i++) {
      const p = this.poses[i];
      sep = Math.min(sep, separacaoCarroCaixa(j.x, j.z, j.yaw, j.hw, j.hl, p.x, p.z, MEIA_LARG_TREM, VEICULOS[i].meioComp));
    }
    if (!this.contatoTrem && sep < 0.04) {
      this.contatoTrem = true;
      if (!this.colidiu) {
        this.colidiu = true;
        this.fila.push('colisao_trem');
      }
    } else if (this.contatoTrem && sep > 0.5) this.contatoTrem = false;
  }

  // ------------------------------------------------------------ cancelas

  private ligarColisor(c: CancelaFisica, sim: boolean): void {
    if (c.colisorLigado === sim) return;
    c.colisorLigado = sim;
    c.colisor.setEnabled(sim);
  }

  private passoCancelas(dt: number, j: ReturnType<Ferrovia['lerJogador']>): void {
    const descer = this.alarme && this.tAlarme >= ATRASO_CANCELA;
    const v = Math.hypot(j.vx, j.vz);
    for (const c of this.cancelas) {
      const d = c.def;
      const zc = d.pivo.z + (d.sentido * d.comp) / 2;
      if (c.quebrada) {
        this.ligarColisor(c, false);
        continue;
      }
      // carro embaixo do braço? (faixa do braço alargada)
      const sepFaixa = separacaoCarroCaixa(j.x, j.z, j.yaw, j.hw, j.hl, d.pivo.x, zc, 0.35, d.comp / 2);
      const embaixo = sepFaixa < 0;
      if (descer) {
        if (!(embaixo && c.ang < 1.2 && c.ang > 0.02)) c.ang = Math.max(0, c.ang - (dt * Math.PI) / 2 / T_DESCER);
      } else {
        c.ang = Math.min(Math.PI / 2, c.ang + (dt * Math.PI) / 2 / T_SUBIR);
      }
      const abaixada = c.ang <= 0.02;
      if (abaixada && v > V_QUEBRA) {
        // prevê a posição do carro no próximo passo: bateu rápido → quebra antes do contato
        const k = 3 * dt;
        const sep = separacaoCarroCaixa(j.x + j.vx * k, j.z + j.vz * k, j.yaw, j.hw, j.hl, d.pivo.x, zc, 0.06, d.comp / 2);
        if (sep < 0.03 && j.y - 0.6 < d.pivo.y) {
          c.quebrada = true;
          this.ligarColisor(c, false);
          continue;
        }
      }
      // liga o colisor só abaixada e sem o carro já embaixo dela
      if (abaixada && !this.ligado(c)) {
        const sep = separacaoCarroCaixa(j.x, j.z, j.yaw, j.hw, j.hl, d.pivo.x, zc, 0.06, d.comp / 2);
        this.ligarColisor(c, sep > 0.02);
      } else if (!abaixada) this.ligarColisor(c, false);
    }
  }

  private ligado(c: CancelaFisica): boolean {
    return c.colisorLigado;
  }

  private posicionarCancelas(teleporte: boolean): void {
    for (const c of this.cancelas) {
      _q.setFromEuler(_e.set(-c.ang * c.def.sentido, 0, 0));
      if (teleporte) c.corpo.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
      else c.corpo.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    }
  }

  // ------------------------------------------------------------ visual

  atualizarVisual(dt: number): void {
    const vis = this.visual;
    if (!vis) return;
    this.tVisual += dt;
    const ativo = this._estado !== 'livre';
    const fase = Math.floor(this.tVisual / 0.55) % 2;
    const ligadaA = ativo && fase === 0;
    const ligadaB = ativo && fase === 1;
    vis.lampA.emissiveIntensity = ligadaA ? 5 : 0.04;
    vis.lampB.emissiveIntensity = ligadaB ? 5 : 0.04;
    for (const g of vis.brilhoA) g.visible = ligadaA;
    for (const g of vis.brilhoB) g.visible = ligadaB;
    // luzes do braço: acesas fixas enquanto não estiver levantada
    vis.lampBraco.emissiveIntensity = ativo ? 4 : 0.04;

    this.cancelas.forEach((c, i) => {
      const cv = vis.cancelas[i];
      cv.pivo.rotation.x = -c.ang * c.def.sentido;
      cv.ponta.visible = !c.quebrada;
      cv.pedaco.visible = c.quebrada;
    });

    VEICULOS.forEach((v, i) => {
      const p = this.poses[i];
      const g = vis.veiculos[i];
      g.raiz.position.set(p.x, p.y, p.z);
      g.raiz.rotation.x = p.pitch;
      const giro = this.percorrido / v.raioRoda;
      for (const r of g.rodas) r.rotation.x = giro;
    });
    const indoNorte = this.sentido <= 0;
    const andando = this.fase === 'ida' || this.fase === 'volta' || this.timer < 3;
    vis.farolLoco.emissiveIntensity = indoNorte ? (andando ? 4 : 1.2) : 0.05;
    vis.farolCarro.emissiveIntensity = !indoNorte ? (andando ? 4 : 1.2) : 0.05;
    vis.lanternaCarro.emissiveIntensity = indoNorte ? 2.5 : 0.05;
    vis.lanternaLoco.emissiveIntensity = !indoNorte ? 2.5 : 0.05;
    vis.fachoLoco.visible = indoNorte && andando;
    vis.fachoCarro.visible = !indoNorte && andando;
  }
}

// =====================================================================
// Visual (só no navegador ou com visuais: true)
// =====================================================================

interface VisualVeiculo {
  raiz: THREE.Group;
  rodas: THREE.Object3D[];
}

interface VisualFerrovia {
  raiz: THREE.Group;
  veiculos: VisualVeiculo[];
  cancelas: { pivo: THREE.Group; ponta: THREE.Object3D; pedaco: THREE.Object3D }[];
  lampA: THREE.MeshStandardMaterial;
  lampB: THREE.MeshStandardMaterial;
  lampBraco: THREE.MeshStandardMaterial;
  brilhoA: THREE.Object3D[];
  brilhoB: THREE.Object3D[];
  farolLoco: THREE.MeshStandardMaterial;
  farolCarro: THREE.MeshStandardMaterial;
  lanternaLoco: THREE.MeshStandardMaterial;
  lanternaCarro: THREE.MeshStandardMaterial;
  fachoLoco: THREE.Object3D;
  fachoCarro: THREE.Object3D;
}

const cacheMat = new Map<string, THREE.MeshStandardMaterial>();
function mat(cor: number, rough = 0.7, metal = 0): THREE.MeshStandardMaterial {
  const k = `${cor}|${rough}|${metal}`;
  let m = cacheMat.get(k);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: cor, roughness: rough, metalness: metal });
    cacheMat.set(k, m);
  }
  return m;
}

function caixa(
  pai: THREE.Object3D, sx: number, sy: number, sz: number, x: number, y: number, z: number,
  m: THREE.Material, sombra = true,
): THREE.Mesh {
  const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
  b.position.set(x, y, z);
  b.castShadow = sombra;
  b.receiveShadow = true;
  pai.add(b);
  return b;
}

function cilindro(
  pai: THREE.Object3D, r: number, h: number, x: number, y: number, z: number, m: THREE.Material,
  eixo: 'x' | 'y' | 'z' = 'y', seg = 14,
): THREE.Mesh {
  const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m);
  if (eixo === 'x') c.rotation.z = Math.PI / 2;
  if (eixo === 'z') c.rotation.x = Math.PI / 2;
  c.position.set(x, y, z);
  c.castShadow = true;
  pai.add(c);
  return c;
}

/** Extruda uma seção (x, y) ao longo de z seguindo a altura `alt(z)` nos pontos dados. */
function extrudar(secao: [number, number][], zs: number[], alt: (z: number) => number, x0: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const ns = secao.length;
  for (let i = 0; i < zs.length - 1; i++) {
    const za = zs[i], zb = zs[i + 1];
    const ya = alt(za), yb = alt(zb);
    for (let k = 0; k < ns; k++) {
      const a = secao[k], b = secao[(k + 1) % ns];
      const p1 = [x0 + a[0], ya + a[1], za];
      const p2 = [x0 + b[0], ya + b[1], za];
      const p3 = [x0 + b[0], yb + b[1], zb];
      const p4 = [x0 + a[0], yb + a[1], zb];
      pos.push(...p1, ...p3, ...p2, ...p1, ...p4, ...p3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function texturaCanvas(larg: number, alt: number, desenhar: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = larg;
  c.height = alt;
  const ctx = c.getContext('2d')!;
  desenhar(ctx);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

let _texBrilho: THREE.Texture | null = null;
function texturaBrilho(): THREE.Texture {
  return (_texBrilho ??= texturaCanvas(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }));
}

function brilho(cor: number, tam: number): THREE.Sprite {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texturaBrilho(), color: cor, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }),
  );
  s.scale.set(tam, tam, 1);
  s.visible = false;
  return s;
}

// ---------------------------------------------------------------- via

function criarVia(raiz: THREE.Group): void {
  const via = new THREE.Group();
  via.name = 'via_permanente';
  raiz.add(via);
  const matTrilho = new THREE.MeshStandardMaterial({ color: 0x6d6a66, roughness: 0.45, metalness: 0.8, side: THREE.DoubleSide });
  const matLastro = new THREE.MeshStandardMaterial({ color: 0x8b8580, roughness: 1, side: THREE.DoubleSide });
  const matDormente = mat(0x9c9890, 0.9);
  const matPainel = mat(0x2f3032, 0.95);
  const matConcreto = mat(0xa9a59c, 0.9);

  const zIni = Z_PARA_CHOQUE - 0.7;
  const zFim = Z_FIM_SUL;
  const zsTrilho = [zIni, ...PERFIL.map((p) => p[0]).filter((z) => z > zIni && z < zFim), zFim];
  // perfil do trilho: boleto, alma, patim (y = 0 no topo)
  const secTrilho: [number, number][] = [
    [-0.036, 0], [0.036, 0], [0.036, -0.045], [0.009, -0.052], [0.009, -0.122], [0.066, -0.138],
    [0.066, -0.155], [-0.066, -0.155], [-0.066, -0.138], [-0.009, -0.122], [-0.009, -0.052], [-0.036, -0.045],
  ];
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(extrudar(secTrilho, zsTrilho, alturaTrilho, XT + s * MEIA_BITOLA), matTrilho);
    m.castShadow = true;
    m.receiveShadow = true;
    via.add(m);
  }

  // lastro (só nos canteiros; abaixo da grama some sozinho)
  const secLastro: [number, number][] = [[-1.5, 0], [1.5, 0], [1.9, -0.38], [-1.9, -0.38]];
  const lastroY = (z: number) => alturaTrilho(z) - 0.22;
  const trechos: [number, number][] = [[Z_PARA_CHOQUE - 0.9, Z_N], [Z_S, Z_FIM_SUL + 2.5]];
  for (const [a, b] of trechos) {
    const zs = [a, ...PERFIL.map((p) => p[0]).filter((z) => z > a && z < b), b];
    const m = new THREE.Mesh(extrudar(secLastro, zs, lastroY, XT), matLastro);
    m.receiveShadow = true;
    via.add(m);
  }

  // dormentes de concreto
  const pos: number[] = [];
  for (const [a, b] of trechos) {
    for (let z = a + 0.4; z < b; z += 0.6) {
      const topo = alturaTrilho(z) - 0.155;
      if (topo > ALTURA_CALCADA + 0.008 && Math.abs(z - (Z_N + Z_S) / 2) > (Z_S - Z_N) / 2 + 0.3) pos.push(z, topo);
    }
  }
  const dorm = new THREE.InstancedMesh(new THREE.BoxGeometry(2.8, 0.17, 0.26), matDormente, pos.length / 2);
  const mm = new THREE.Matrix4();
  for (let i = 0; i < pos.length / 2; i++) {
    mm.makeTranslation(XT, pos[2 * i + 1] - 0.085, pos[2 * i]);
    dorm.setMatrixAt(i, mm);
  }
  dorm.castShadow = true;
  dorm.receiveShadow = true;
  via.add(dorm);
  // fixações (grampos) — uma instância por trilho por dormente
  const fix = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.05, 0.12), mat(0x3a3a38, 0.6, 0.5), pos.length);
  for (let i = 0; i < pos.length / 2; i++) {
    for (const s of [-1, 1]) {
      mm.makeTranslation(XT + s * MEIA_BITOLA, pos[2 * i + 1] + 0.02, pos[2 * i]);
      fix.setMatrixAt(2 * i + (s > 0 ? 1 : 0), mm);
    }
  }
  via.add(fix);

  // passagem: painéis de borracha rentes ao asfalto, com sulcos para os frisos das rodas
  const faixasX: [number, number][] = [
    [-1.55, -MEIA_BITOLA - 0.08],
    [-MEIA_BITOLA + 0.08, MEIA_BITOLA - 0.08],
    [MEIA_BITOLA + 0.08, 1.55],
  ];
  const zp0 = Z_N + RAMPA_RUA, zp1 = Z_S - RAMPA_RUA;
  const nMod = Math.round((zp1 - zp0) / 1.8);
  const lMod = (zp1 - zp0) / nMod;
  for (const [x0, x1] of faixasX) {
    for (let k = 0; k < nMod; k++) {
      caixa(via, x1 - x0, 0.03, lMod - 0.025, XT + (x0 + x1) / 2, R_VIA - 0.002 - 0.015, zp0 + (k + 0.5) * lMod, matPainel, false);
    }
  }
  // sulcos (fundo escuro entre trilho e painel)
  for (const s of [-1, 1]) for (const d of [-1, 1]) {
    caixa(via, 0.07, 0.01, zp1 - zp0, XT + s * MEIA_BITOLA + d * 0.075, 0.004, (zp0 + zp1) / 2, mat(0x151515, 1), false);
  }
  // concreto inclinado junto ao meio-fio (rua) e laje de aproximação nos canteiros
  for (const [zm, sinal] of [[Z_N, 1], [Z_S, -1]] as [number, number][]) {
    const comp = Math.hypot(RAMPA_RUA, R_MEIO_FIO - R_VIA);
    const rampa = caixa(via, 3.3, 0.06, comp, XT, (R_MEIO_FIO + R_VIA) / 2 - 0.035, zm + (sinal * RAMPA_RUA) / 2, matConcreto, false);
    rampa.rotation.x = sinal * Math.atan2(R_MEIO_FIO - R_VIA, RAMPA_RUA);
    caixa(via, 3.3, 0.04, 6, XT, ALTURA_CALCADA + 0.005, zm - sinal * 3, matConcreto, false);
  }

  // para-choques nas duas pontas
  via.add(criarParaChoque(Z_PARA_CHOQUE, 1));
  via.add(criarParaChoque(Z_FIM_SUL - 0.3, -1));
}

/** Para-choque de fim de linha; `face` +1 = recebe trens vindo de +z. */
function criarParaChoque(z: number, face: 1 | -1): THREE.Group {
  const g = new THREE.Group();
  g.name = 'para_choque';
  const y0 = alturaTrilho(z);
  g.position.set(XT, y0, z);
  if (face < 0) g.rotation.y = Math.PI;
  const aco = mat(0x3d3f42, 0.55, 0.6);
  // montantes inclinados apoiados nos trilhos
  for (const s of [-1, 1]) {
    const m = caixa(g, 0.18, 1.5, 0.2, s * MEIA_BITOLA, 0.62, -0.45, aco);
    m.rotation.x = -0.55;
    caixa(g, 0.18, 1.1, 0.2, s * MEIA_BITOLA, 0.55, 0.05, aco);
  }
  // viga com faixas vermelhas e brancas
  const viga = new THREE.Group();
  viga.position.set(0, 1.05, 0.15);
  g.add(viga);
  for (let i = 0; i < 6; i++) caixa(viga, 0.5, 0.36, 0.3, -1.25 + i * 0.5, 0, 0, mat(i % 2 ? 0xf2f2ee : 0xc8201c, 0.6));
  for (const s of [-1, 1]) {
    cilindro(g, 0.17, 0.3, s * 0.95, 1.05, 0.45, mat(0x222222, 0.5, 0.4), 'z');
    cilindro(g, 0.2, 0.05, s * 0.95, 1.05, 0.62, aco, 'z');
  }
  // lanterna vermelha
  const lan = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2010, emissiveIntensity: 1.5 });
  cilindro(g, 0.1, 0.12, 0, 1.4, 0.15, lan, 'z');
  // bloco de concreto atrás (ancoragem), estreito: ao norte a ilha afina junto da avenida diagonal
  caixa(g, 2.2, 0.5, 0.8, 0, 0.0, -1.1, mat(0x9d998f, 0.9));
  return g;
}

// ---------------------------------------------------------------- estação

function criarEstacao(raiz: THREE.Group): void {
  const g = new THREE.Group();
  g.name = 'estacao';
  raiz.add(g);
  const concreto = mat(0xb9b4a9, 0.9);
  const { x0, x1, z0, z1, topo } = PLAT;
  const h = topo - ALTURA_CALCADA;
  caixa(g, x1 - x0, h, z1 - z0, (x0 + x1) / 2, ALTURA_CALCADA + h / 2, (z0 + z1) / 2, concreto);
  // borda (pingadeira) branca e faixa amarela de segurança
  caixa(g, 0.3, 0.02, z1 - z0, x1 - 0.15, topo + 0.006, (z0 + z1) / 2, mat(0xeeeeea, 0.8), false);
  caixa(g, 0.4, 0.02, z1 - z0, x1 - 0.6, topo + 0.006, (z0 + z1) / 2, mat(0xf2c21b, 0.7), false);
  // rampa ao norte
  const compR = 8;
  const rampa = caixa(g, 2.2, 0.2, Math.hypot(compR, h), x0 + 1.3, ALTURA_CALCADA + h / 2 - 0.1, z0 - compR / 2, concreto);
  rampa.rotation.x = -Math.atan2(h, compR);
  // guarda-corpo do lado oeste da rampa e da plataforma
  const metal = mat(0x6f7478, 0.5, 0.6);
  caixa(g, 0.05, 0.05, z1 - z0, x0 + 0.05, topo + 1.0, (z0 + z1) / 2, metal);
  for (let z = z0; z <= z1; z += 2.5) caixa(g, 0.05, 1.0, 0.05, x0 + 0.05, topo + 0.5, z, metal);

  // abrigo
  const zA = (z0 + z1) / 2 - 2, compA = 9;
  const xa0 = x0 + 0.3, xa1 = x0 + 2.6;
  for (const x of [xa0 + 0.1, xa1 - 0.1]) for (const z of [zA - compA / 2 + 0.2, zA, zA + compA / 2 - 0.2]) {
    caixa(g, 0.12, x === xa0 + 0.1 ? 2.9 : 2.6, 0.12, x, topo + (x === xa0 + 0.1 ? 1.45 : 1.3), z, mat(0x2c5a8a, 0.5, 0.4));
  }
  const telhado = caixa(g, 3.2, 0.1, compA + 0.6, (xa0 + xa1) / 2, topo + 2.8, zA, mat(0xd8dadb, 0.5, 0.5));
  telhado.rotation.z = 0.12;
  // parede de vidro ao fundo e banco
  const vidro = new THREE.MeshStandardMaterial({ color: 0x9fc4d8, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.35 });
  caixa(g, 0.03, 2.2, compA - 0.4, xa0 + 0.1, topo + 1.4, zA, vidro, false);
  caixa(g, 0.45, 0.06, 3.5, xa0 + 0.5, topo + 0.45, zA, mat(0x8a5a32, 0.8));
  caixa(g, 0.08, 0.45, 3.5, xa0 + 0.3, topo + 0.75, zA, mat(0x8a5a32, 0.8));
  for (const dz of [-1.5, 1.5]) caixa(g, 0.4, 0.42, 0.06, xa0 + 0.5, topo + 0.21, zA + dz, metal);

  // placa com o nome da estação
  if (typeof document !== 'undefined') {
    const tex = texturaCanvas(512, 128, (ctx) => {
      ctx.fillStyle = '#1d4f91';
      ctx.fillRect(0, 0, 512, 128);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 6;
      ctx.strokeRect(8, 8, 496, 112);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 54px Arial, "Liberation Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AUTOESCOLA', 256, 68);
    });
    const placa = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }));
    placa.position.set(xa0 + 1.4, topo + 3.25, zA + compA / 2 + 1.0);
    placa.rotation.y = Math.PI / 2;
    g.add(placa);
    const verso = placa.clone();
    verso.rotation.y = -Math.PI / 2;
    verso.position.x -= 0.02;
    g.add(verso);
    for (const dz of [-1.0, 1.0]) caixa(g, 0.06, 3.5, 0.06, xa0 + 1.39, topo + 1.75, zA + compA / 2 + 1.0 + dz, metal);
  }
  // postes de luz
  for (const z of [z0 + 2, z1 - 2]) {
    caixa(g, 0.1, 4, 0.1, x0 + 0.5, topo + 2, z, metal);
    caixa(g, 0.9, 0.08, 0.2, x0 + 0.9, topo + 4, z, metal);
    caixa(g, 0.5, 0.05, 0.25, x0 + 1.1, topo + 3.95, z, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d0, emissiveIntensity: 0.6 }));
  }
}

// ---------------------------------------------------------------- equipamentos da passagem

function criarCruzSantoAndre(): THREE.Group {
  // A-41: duas tábuas brancas com borda vermelha em X
  const g = new THREE.Group();
  const verm = mat(0xc4161c, 0.5);
  const branco = new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.45, emissive: 0xffffff, emissiveIntensity: 0.12 });
  for (const s of [-1, 1]) {
    const t = new THREE.Group();
    t.rotation.z = s * (Math.PI / 4.4);
    g.add(t);
    caixa(t, 1.25, 0.24, 0.025, 0, 0, 0, verm);
    caixa(t, 1.17, 0.16, 0.004, 0, 0, 0.015 + s * 0.002, branco, false);
  }
  return g;
}

function criarMastro(lampA: THREE.Material, lampB: THREE.Material, brilhoA: THREE.Object3D[], brilhoB: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  g.name = 'mastro_pn';
  const preto = mat(0x161616, 0.6);
  const branco = mat(0xf0f0ec, 0.6);
  // poste listrado embaixo
  for (let i = 0; i < 6; i++) cilindro(g, 0.075, 0.3, 0, 0.15 + i * 0.3, 0, i % 2 ? branco : preto);
  cilindro(g, 0.07, 2.4, 0, 3.0, 0, mat(0x9ea3a7, 0.4, 0.7));
  caixa(g, 0.5, 0.15, 0.5, 0, 0.075, 0, mat(0x8f8b84, 0.9));
  const cruz = criarCruzSantoAndre();
  cruz.position.set(0, 3.75, 0.09);
  g.add(cruz);
  // luzes: suporte horizontal, fundo preto com aro branco, dois focos vermelhos com pala
  caixa(g, 1.4, 0.1, 0.1, 0, 2.55, 0.05, preto);
  for (const s of [-1, 1]) {
    const lamp = s < 0 ? lampA : lampB;
    const fundo = new THREE.Mesh(new THREE.CircleGeometry(0.3, 24), preto);
    fundo.position.set(s * 0.55, 2.55, 0.11);
    g.add(fundo);
    const aro = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.34, 24), branco);
    aro.position.set(s * 0.55, 2.55, 0.11);
    g.add(aro);
    const foco = new THREE.Mesh(new THREE.CircleGeometry(0.15, 20), lamp);
    foco.position.set(s * 0.55, 2.55, 0.125);
    g.add(foco);
    // pala (viseira) inclinada sobre o foco
    const pala = caixa(g, 0.42, 0.025, 0.24, s * 0.55, 2.55 + 0.2, 0.23, preto);
    pala.rotation.x = 0.25;
    const b = brilho(0xff2a10, 1.3);
    b.position.set(s * 0.55, 2.55, 0.3);
    g.add(b);
    (s < 0 ? brilhoA : brilhoB).push(b);
  }
  // sino no topo
  const sino = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x222222, 0.4, 0.6));
  sino.position.set(0, 4.25, 0);
  g.add(sino);
  return g;
}

function criarCancelaVisual(def: DefCancela, lampBraco: THREE.Material): { raiz: THREE.Group; pivo: THREE.Group; ponta: THREE.Object3D; pedaco: THREE.Object3D } {
  const raiz = new THREE.Group();
  raiz.name = 'cancela';
  // gabinete do mecanismo
  const base = new THREE.Vector3(def.pivo.x, ALTURA_CALCADA, def.pivo.z);
  const xg = base.x + def.ladoX * 0.38;
  caixa(raiz, 0.45, 1.05, 0.45, xg, base.y + 0.525, base.z, mat(0xd9d9d4, 0.6, 0.2));
  caixa(raiz, 0.5, 0.06, 0.5, xg, base.y + 1.08, base.z, mat(0x9a9a96, 0.5, 0.3));
  const pivo = new THREE.Group();
  pivo.position.copy(def.pivo);
  raiz.add(pivo);
  // eixo e contrapeso
  cilindro(pivo, 0.06, 0.5, def.ladoX * 0.2, 0, 0, mat(0x444444, 0.5, 0.6), 'x');
  caixa(pivo, 0.16, 0.22, 0.55, 0, 0, -def.sentido * 0.5, mat(0x333333, 0.6, 0.3));
  // braço listrado vermelho/branco (0,5 m por faixa); primeiro trecho fica, o resto pode quebrar
  const ponta = new THREE.Group();
  pivo.add(ponta);
  const n = Math.round(def.comp / 0.5);
  const passo = def.comp / n;
  for (let i = 0; i < n; i++) {
    const alvo = i < 2 ? pivo : ponta;
    caixa(alvo, 0.07, 0.1, passo, 0, 0, def.sentido * (0.15 + (i + 0.5) * passo), mat(i % 2 ? 0xf4f4f0 : 0xd0201c, 0.5));
  }
  // três luzes vermelhas no braço
  for (const f of [0.45, 0.72, 0.98]) {
    cilindro(ponta, 0.045, 0.05, 0, 0.08, def.sentido * (0.15 + f * def.comp), lampBraco, 'y', 10);
  }
  // pedaço quebrado caído no asfalto (aparece se a cancela quebrar)
  const pedaco = new THREE.Group();
  pedaco.visible = false;
  for (let i = 0; i < 3; i++) {
    caixa(pedaco, 0.07, 0.1, passo, 0, 0.05, i * passo, mat(i % 2 ? 0xf4f4f0 : 0xd0201c, 0.5));
  }
  pedaco.position.set(def.pivo.x - def.ladoX * 1.5, 0, def.pivo.z + def.sentido * 2.2);
  pedaco.rotation.y = 0.7;
  raiz.add(pedaco);
  return { raiz, pivo, ponta, pedaco };
}

/** A-40: passagem de nível com barreira (losango amarelo; desenho de cancela/porteira). */
function criarPlacaA40(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'placa A-40';
  const lado = 0.6;
  const diag = lado * Math.SQRT2;
  const base = 2.1;
  const cy = base + diag / 2;
  cilindro(g, 0.032, cy + diag / 2 - 0.04, 0, (cy + diag / 2 - 0.04) / 2, 0, mat(0xb8bcbf, 0.38, 0.75));
  const tex = texturaCanvas(512, 512, (ctx) => {
    ctx.translate(256, 256);
    ctx.rotate(Math.PI / 4);
    const L = 512 / Math.SQRT2 - 4;
    ctx.fillStyle = '#141414';
    ctx.fillRect(-L / 2, -L / 2, L, L);
    ctx.fillStyle = '#f6b90f';
    ctx.fillRect(-L / 2 + 14, -L / 2 + 14, L - 28, L - 28);
    ctx.strokeStyle = '#141414';
    ctx.lineWidth = 7;
    ctx.strokeRect(-L / 2 + 24, -L / 2 + 24, L - 48, L - 48);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // porteira: dois mourões, três travessas e diagonal
    ctx.fillStyle = '#141414';
    ctx.fillRect(150, 190, 22, 150);
    ctx.fillRect(340, 190, 22, 150);
    for (const y of [205, 255, 305]) ctx.fillRect(150, y, 212, 18);
    ctx.save();
    ctx.translate(256, 264);
    ctx.rotate(-0.42);
    ctx.fillRect(-105, -8, 210, 16);
    ctx.restore();
  });
  // recorta o losango com uma ShapeGeometry (UV: quadrado da textura)
  const forma = new THREE.Shape([
    new THREE.Vector2(0, diag / 2), new THREE.Vector2(diag / 2, 0), new THREE.Vector2(0, -diag / 2), new THREE.Vector2(-diag / 2, 0),
  ]);
  const geo = new THREE.ShapeGeometry(forma);
  const uv = geo.attributes.uv;
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / diag + 0.5, p.getY(i) / diag + 0.5);
  const face = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.42, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.18 }),
  );
  face.position.set(0, cy, 0.06);
  g.add(face);
  const verso = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8e9397, metalness: 0.55, roughness: 0.55, side: THREE.BackSide }));
  verso.position.set(0, cy, 0.056);
  g.add(verso);
  caixa(g, 0.11, 0.04, 0.05, 0, cy - 0.15, 0.03, mat(0x7d8286, 0.45, 0.7));
  caixa(g, 0.11, 0.04, 0.05, 0, cy + 0.15, 0.03, mat(0x7d8286, 0.45, 0.7));
  return g;
}

// ---------------------------------------------------------------- trem

function truque(pai: THREE.Object3D, z: number, v: Veiculo, rodas: THREE.Object3D[]): void {
  const t = new THREE.Group();
  t.position.z = z;
  pai.add(t);
  const preto = mat(0x1d1d1d, 0.7, 0.3);
  const aco = mat(0x55595c, 0.45, 0.8);
  const r = v.raioRoda;
  const vao = v.eixos[v.eixos.length - 1] - v.eixos[0];
  for (const s of [-1, 1]) {
    caixa(t, 0.16, 0.38, vao + r * 2 + 0.3, s * 1.0, r + 0.05, 0, preto);
    // molas
    for (const e of v.eixos) cilindro(t, 0.08, 0.25, s * 1.0, r + 0.32, e, aco);
  }
  caixa(t, 1.9, 0.25, 0.6, 0, r + 0.25, 0, preto);
  for (const e of v.eixos) {
    const eixo = new THREE.Group();
    eixo.position.set(0, r, e);
    t.add(eixo);
    cilindro(eixo, 0.08, MEIA_BITOLA * 2 + 0.1, 0, 0, 0, aco, 'x', 8);
    for (const s of [-1, 1]) {
      cilindro(eixo, r, 0.13, s * MEIA_BITOLA, 0, 0, aco, 'x', 18);
      cilindro(eixo, r + 0.03, 0.03, s * (MEIA_BITOLA - 0.075), 0, 0, aco, 'x', 18); // friso
      // raio pintado para dar sensação de giro
      caixa(eixo, 0.02, r * 1.6, 0.08, s * (MEIA_BITOLA + 0.07), 0, 0, mat(0xb0b0b0, 0.5, 0.6), false);
    }
    rodas.push(eixo);
  }
}

function criarLocomotiva(farol: THREE.Material, lanterna: THREE.Material): { vis: VisualVeiculo; facho: THREE.Object3D } {
  const raiz = new THREE.Group();
  raiz.name = 'locomotiva';
  const rodas: THREE.Object3D[] = [];
  const v = LOCO;
  const L = COMP_LOCO;
  const amarelo = mat(0xe3ad16, 0.55, 0.15);
  const azul = mat(0x1c3f86, 0.55, 0.15);
  const cinza = mat(0x2a2c2f, 0.7, 0.3);
  const vidro = new THREE.MeshStandardMaterial({ color: 0x1a2630, roughness: 0.08, metalness: 0.5 });
  for (const s of [-1, 1]) truque(raiz, s * v.truque, v, rodas);
  // estrado, longarina azul, tanque de combustível, limpa-trilhos e engates
  caixa(raiz, 2.95, 0.32, L - 0.2, 0, 1.36, 0, cinza);
  for (const s of [-1, 1]) caixa(raiz, 0.03, 0.28, L - 0.3, s * 1.49, 1.36, 0, azul);
  caixa(raiz, 2.3, 0.75, 4.6, 0, 0.92, 0, mat(0x202224, 0.6, 0.4));
  for (const s of [-1, 1]) {
    const lt = caixa(raiz, 2.8, 0.7, 0.18, 0, 0.75, s * (L / 2 - 0.15), amarelo);
    lt.rotation.x = s * 0.25;
    caixa(raiz, 0.3, 0.25, 0.5, 0, 1.0, s * (L / 2 + 0.15), cinza);
    // listras de advertência nas cabeceiras
    for (let i = -2; i <= 2; i++) {
      const f = caixa(raiz, 0.22, 0.32, 0.02, i * 0.55, 1.36, s * (L / 2 - 0.08), i % 2 ? amarelo : mat(0x111111, 0.6), false);
      f.rotation.z = 0.5;
    }
  }
  // capô curto (frente, −z), cabine, capô longo
  const zf = -L / 2;
  caixa(raiz, 2.0, 1.35, 1.9, 0, 1.52 + 0.675, zf + 0.25 + 0.95, amarelo);
  caixa(raiz, 2.95, 2.55, 2.7, 0, 1.52 + 1.275, zf + 2.15 + 1.35, amarelo);
  caixa(raiz, 3.05, 0.12, 2.9, 0, 4.13, zf + 2.15 + 1.35, mat(0x3c3f42, 0.6, 0.3));
  caixa(raiz, 2.96, 0.32, 2.72, 0, 2.2, zf + 2.15 + 1.35, azul); // faixa
  // janelas da cabine
  for (const s of [-1, 1]) {
    caixa(raiz, 1.15, 0.85, 0.03, s * 0.7, 3.4, zf + 2.14, vidro, false);
    caixa(raiz, 0.03, 0.8, 1.0, s * 1.48, 3.35, zf + 2.85, vidro, false);
    caixa(raiz, 0.03, 0.8, 0.8, s * 1.48, 3.35, zf + 4.05, vidro, false);
    // porta da cabine
    caixa(raiz, 0.03, 1.8, 0.7, s * 1.48, 2.45, zf + 3.45, mat(0xc89a12, 0.55, 0.15), false);
  }
  const zl0 = zf + 4.85, zl1 = L / 2 - 0.25;
  caixa(raiz, 2.1, 2.1, zl1 - zl0, 0, 1.52 + 1.05, (zl0 + zl1) / 2, amarelo);
  for (const s of [-1, 1]) {
    caixa(raiz, 2.12, 0.3, zl1 - zl0, 0, 2.2, (zl0 + zl1) / 2, azul);
    // portinholas e grelhas do motor/radiador
    for (let i = 0; i < 6; i++) caixa(raiz, 0.02, 1.0, 0.9, s * 1.06, 2.95, zl0 + 0.7 + i * 1.05, mat(0xcf9c12, 0.6, 0.15), false);
    caixa(raiz, 0.02, 1.2, 1.8, s * 1.06, 2.9, zl1 - 1.2, mat(0x3a3a3a, 0.8, 0.3), false);
  }
  caixa(raiz, 1.6, 0.35, 2.4, 0, 3.78, zl0 + 2.8, amarelo); // freio dinâmico
  for (const z of [zl1 - 0.8, zl1 - 2.0]) {
    cilindro(raiz, 0.6, 0.12, 0, 3.66, z, mat(0x2d2f31, 0.6, 0.4), 'y', 18);
  }
  caixa(raiz, 0.35, 0.4, 0.6, 0, 3.8, zl0 + 5.0, mat(0x1b1b1b, 0.8)); // escapamento
  // buzina na cabine
  for (const s of [-0.25, 0, 0.25]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.03, 0.35 + Math.abs(s), 10), mat(0x9a9a96, 0.4, 0.7));
    b.rotation.x = Math.PI / 2;
    b.position.set(s, 4.32, zf + 3.0 + s);
    raiz.add(b);
  }
  // corrimãos e passadiços
  const corr = mat(0xe8e8e2, 0.5, 0.3);
  for (const s of [-1, 1]) {
    caixa(raiz, 0.04, 0.04, zl1 - zl0, s * 1.4, 2.5, (zl0 + zl1) / 2, corr);
    for (let z = zl0; z <= zl1; z += 1.6) caixa(raiz, 0.035, 1.0, 0.035, s * 1.4, 2.0, z, corr);
    caixa(raiz, 0.04, 0.04, 1.9, s * 1.4, 2.5, zf + 1.2, corr);
  }
  // faróis: dois no alto do capô curto, dois no capô longo; faroletes no limpa-trilhos
  for (const s of [-1, 1]) {
    cilindro(raiz, 0.11, 0.06, s * 0.22, 2.75, zf + 0.22, farol, 'z');
    cilindro(raiz, 0.09, 0.06, s * 1.15, 1.15, zf + 0.12, farol, 'z');
    cilindro(raiz, 0.11, 0.06, s * 0.22, 3.4, zl1 + 0.02, lanterna, 'z');
  }
  // numeração
  caixa(raiz, 0.9, 0.22, 0.02, 0, 2.95, zf + 0.24, mat(0x111111, 0.5), false);
  // facho de luz (sprite) na frente
  const facho = brilho(0xfff1c8, 2.6);
  facho.position.set(0, 2.75, zf - 0.2);
  raiz.add(facho);
  return { vis: { raiz, rodas }, facho };
}

function criarCarroPassageiros(farol: THREE.Material, lanterna: THREE.Material): { vis: VisualVeiculo; facho: THREE.Object3D } {
  const raiz = new THREE.Group();
  raiz.name = 'carro_passageiros';
  const rodas: THREE.Object3D[] = [];
  const v = CARRO;
  const L = COMP_CARRO;
  const inox = mat(0xc4c8cc, 0.35, 0.65);
  const azul = mat(0x1c3f86, 0.5, 0.2);
  const vidro = new THREE.MeshStandardMaterial({ color: 0x1b2833, roughness: 0.08, metalness: 0.5 });
  const cinza = mat(0x2a2c2f, 0.7, 0.3);
  for (const s of [-1, 1]) truque(raiz, s * v.truque, v, rodas);
  caixa(raiz, 2.7, 0.25, L - 0.4, 0, 1.0, 0, cinza);
  caixa(raiz, 2.0, 0.55, 3.0, 0, 0.75, 0, mat(0x1f2124, 0.7, 0.3)); // equipamentos
  caixa(raiz, 2.95, 2.45, L, 0, 1.12 + 1.225, 0, inox);
  const teto = new THREE.Mesh(new THREE.CylinderGeometry(1.475, 1.475, L, 20, 1, false, -Math.PI / 2, Math.PI), mat(0xb4b8bb, 0.4, 0.6));
  teto.rotation.x = -Math.PI / 2;
  teto.scale.set(1, 1, 0.22);
  teto.position.y = 3.57;
  raiz.add(teto);
  // ar-condicionado
  caixa(raiz, 1.3, 0.28, 2.2, 0, 3.92, 1.5, mat(0x9ea2a5, 0.5, 0.5));
  for (const s of [-1, 1]) {
    caixa(raiz, 0.02, 0.22, L, s * 1.48, 1.55, 0, azul);
    caixa(raiz, 0.02, 0.08, L, s * 1.48, 3.15, 0, azul);
    // janelas entre as portas
    const portas = [-2.7, 2.7];
    for (let z = -L / 2 + 0.9; z < L / 2 - 0.6; z += 1.25) {
      if (portas.some((p) => Math.abs(z - p) < 0.9)) continue;
      caixa(raiz, 0.02, 0.85, 1.05, s * 1.485, 2.5, z, vidro, false);
    }
    for (const p of portas) {
      caixa(raiz, 0.025, 2.05, 1.3, s * 1.485, 2.15, p, mat(0x6e7378, 0.4, 0.6), false);
      for (const d of [-0.33, 0.33]) caixa(raiz, 0.03, 0.9, 0.42, s * 1.487, 2.55, p + d, vidro, false);
    }
  }
  // cabine de comando na ponta sul (+z): para-brisa, faróis, lanternas
  const zt = L / 2;
  caixa(raiz, 2.4, 0.9, 0.03, 0, 2.75, zt + 0.01, vidro, false);
  caixa(raiz, 2.96, 0.25, 0.03, 0, 1.55, zt + 0.01, azul, false);
  for (const s of [-1, 1]) {
    cilindro(raiz, 0.1, 0.05, s * 0.9, 1.9, zt + 0.03, farol, 'z');
    cilindro(raiz, 0.07, 0.05, s * 1.2, 1.9, zt + 0.03, lanterna, 'z');
  }
  caixa(raiz, 2.6, 0.55, 0.15, 0, 0.75, zt - 0.05, mat(0x1d1d1d, 0.7));
  caixa(raiz, 0.3, 0.25, 0.5, 0, 1.0, zt + 0.2, cinza);
  // sanfona na ponta norte (para a locomotiva)
  caixa(raiz, 1.6, 2.3, 0.4, 0, 2.3, -L / 2 - 0.2, mat(0x151515, 0.9));
  caixa(raiz, 0.3, 0.25, 0.5, 0, 1.0, -L / 2 - 0.2, cinza);
  const facho = brilho(0xfff1c8, 2.2);
  facho.position.set(0, 1.9, zt + 0.25);
  raiz.add(facho);
  return { vis: { raiz, rodas }, facho };
}

// ---------------------------------------------------------------- montagem

function emissivo(cor: number, emiss: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: cor, emissive: emiss, emissiveIntensity: 0.05, roughness: 0.3, toneMapped: false });
}

function criarVisual(): VisualFerrovia {
  const raiz = new THREE.Group();
  criarVia(raiz);
  criarEstacao(raiz);

  const lampA = emissivo(0x3a0505, 0xff1e0a);
  const lampB = emissivo(0x3a0505, 0xff1e0a);
  const lampBraco = emissivo(0x3a0505, 0xff1e0a);
  const brilhoA: THREE.Object3D[] = [];
  const brilhoB: THREE.Object3D[] = [];
  for (const m of DEF_MASTROS) {
    const g = criarMastro(lampA, lampB, brilhoA, brilhoB);
    g.position.copy(m.pos);
    g.rotation.y = m.ladoX < 0 ? -Math.PI / 2 : Math.PI / 2; // face para quem vem
    raiz.add(g);
  }
  const cancelas = DEF_CANCELAS.map((d) => {
    const c = criarCancelaVisual(d, lampBraco);
    raiz.add(c.raiz);
    return c;
  });

  // placas A-40 (empurradas para a calçada/grama se caírem no asfalto)
  const g = lerGrade();
  const C = grade.celulaPx;
  const elev = (x: number, y: number) => {
    const cx = Math.floor(x / C), cy = Math.floor(y / C);
    return cy < 0 || cy >= g.length || cx < 0 || cx >= g[0].length || g[cy][cx];
  };
  for (const p of PLACAS_FERROVIA_PX) {
    let { x, y } = p;
    for (let r = 4; r < 80 && !elev(x, y); r += 4) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
        const xx = p.x + Math.cos(a) * r, yy = p.y + Math.sin(a) * r;
        if (elev(xx, yy)) { x = xx; y = yy; break; }
      }
    }
    const pl = criarPlacaA40();
    pl.position.copy(px(x, y, ALTURA_CALCADA));
    pl.rotation.y = Math.atan2(p.face[0], p.face[1]);
    raiz.add(pl);
  }

  const farolLoco = emissivo(0xd8d4c0, 0xfff4d6);
  const farolCarro = emissivo(0xd8d4c0, 0xfff4d6);
  const lanternaLoco = emissivo(0x3a0505, 0xff1a0a);
  const lanternaCarro = emissivo(0x3a0505, 0xff1a0a);
  const loco = criarLocomotiva(farolLoco, lanternaLoco);
  const carro = criarCarroPassageiros(farolCarro, lanternaCarro);
  raiz.add(loco.vis.raiz, carro.vis.raiz);

  return {
    raiz,
    veiculos: [loco.vis, carro.vis],
    cancelas: cancelas.map(({ pivo, ponta, pedaco }) => ({ pivo, ponta, pedaco })),
    lampA, lampB, lampBraco, brilhoA, brilhoB,
    farolLoco, farolCarro, lanternaLoco, lanternaCarro,
    fachoLoco: loco.facho, fachoCarro: carro.facho,
  };
}
