import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Simulacao } from '../sim/simulation';
import type { InfoTrafego } from './infoTrafego';
import type { Zona } from './parser';
import { ALTURA_CALCADA, alturaTerreno, lerGrade, METROS_POR_PX, px } from './autoescola';
import { corSemaforo } from '../exam/exam';
import grade from './autoescola/grade.json';
import { faixaPorId } from './vias';

/**
 * Trânsito da pista da autoescola: carros (corpos cinemáticos que seguem as
 * faixas de vias.ts) e pedestres que atravessam nas faixas de pedestres.
 *
 * Tudo roda sem DOM (os testes usam `{ visuais: false }`). A lógica fica no
 * passo da física (200 Hz); o visual só copia o estado em `atualizarVisual`.
 *
 * Rotas (todas fechadas, então ninguém precisa “renascer”):
 *  - anel_externo: a volta anti-horária inteira.
 *  - diagonal_2 / diagonal_3: sobe a avenida, para no PARE, vira à direita no
 *    anel interno (horário), desce pela direita, vira à direita de novo e
 *    volta ao começo da diagonal. Assim nenhum carro do trânsito passa pelo
 *    trecho da baliza (lado esquerdo do anel interno).
 * As linhas centrais de vias.json são corrigidas aqui (afastadas do meio-fio e
 * da mão contrária e suavizadas), sem alterar o arquivo.
 */

export interface OpcoesTrafego {
  /** Quantidade de carros (padrão 6). */
  carros?: number;
  /** Quantidade de pedestres (padrão 6). */
  pedestres?: number;
  /** Semente do sorteio (posições, cores, tempos). */
  semente?: number;
  /** Cria as malhas (padrão true). Nos testes: false. */
  visuais?: boolean;
}

// ---------------------------------------------------------------- constantes

const H = 0.5; // espaçamento das amostras das rotas (m)
const V_MAX = 8.0; // m/s (~29 km/h)
const A_LAT = 1.6; // aceleração lateral confortável nas curvas (m/s²)
const A_CONF = 2.5; // desaceleração planejada (m/s²)
const A_FREIO = 4; // frenagem normal (m/s²)
const A_EMERG = 8; // frenagem de emergência (m/s²)
const OLHAR = 25; // alcance do “olhar” à frente (m)
const N_OLHAR = Math.ceil(OLHAR / H);
const DIST_SEGURA = 3; // folga para-choque a para-choque, parado (m)
const TEMPO_PARE = 1.5; // s parado no PARE

const CARRO_MEIA_LARG = 0.85;
const CARRO_MEIO_COMP = 1.95;
const CARRO_MEIA_ALT = 0.62;
const CARRO_Y = 0.2 + CARRO_MEIA_ALT; // centro do colisor acima do asfalto

const PED_RAIO = 0.25;
const PED_MEIA_ALT = 0.6; // meia altura do cilindro da cápsula
const PED_VEL = 1.3;

const ROTAS_USADAS = ['anel_externo', 'diagonal_2', 'diagonal_1'];

const CORES_CARRO = [0xf2f2f0, 0xb9bcc0, 0x1c1d20, 0x5d6066, 0xa3171c, 0x1f3f8a, 0xdedad0, 0x2f5a3a, 0x7a7d82, 0xf2f2f0];
const PELES = [0xf1c8a5, 0xd9a37e, 0xa86f4c, 0x6e4630, 0xe8b996];
const ROUPAS = [0x2b4c7e, 0xb03a2e, 0x2e7d4f, 0xe0b23a, 0x6b3f8a, 0xdddddd, 0x222222, 0xd9762b, 0x3a8fb7, 0x8a2846];
const CALCAS = [0x1f2a44, 0x2a2a2a, 0x5a4a3a, 0x3d5a80, 0x6b6b6b, 0xc9b48a];
const CABELOS = [0x1a1410, 0x3b2616, 0x6b4423, 0xb08a4a, 0x888888];

// ---------------------------------------------------------------- utilidades

/** Gerador pseudoaleatório determinístico (mulberry32). */
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

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/**
 * Separação entre dois retângulos orientados no plano XZ (teorema do eixo
 * separador). > 0: afastados por pelo menos isso; ≤ 0: sobrepostos.
 * yaw: rotação em torno de Y, frente = (sin yaw, cos yaw).
 */
export function separacaoOBB(
  ax: number, az: number, ayaw: number, ahw: number, ahl: number,
  bx: number, bz: number, byaw: number, bhw: number, bhl: number,
): number {
  const afx = Math.sin(ayaw), afz = Math.cos(ayaw);
  const bfx = Math.sin(byaw), bfz = Math.cos(byaw);
  const dx = bx - ax, dz = bz - az;
  let sep = -Infinity;
  // eixos: frente e lado de cada um
  for (let k = 0; k < 4; k++) {
    let ux: number, uz: number;
    if (k === 0) { ux = afx; uz = afz; }
    else if (k === 1) { ux = afz; uz = -afx; }
    else if (k === 2) { ux = bfx; uz = bfz; }
    else { ux = bfz; uz = -bfx; }
    const ra = ahl * Math.abs(afx * ux + afz * uz) + ahw * Math.abs(afz * ux - afx * uz);
    const rb = bhl * Math.abs(bfx * ux + bfz * uz) + bhw * Math.abs(bfz * ux - bfx * uz);
    const s = Math.abs(dx * ux + dz * uz) - ra - rb;
    if (s > sep) sep = s;
  }
  return sep;
}

/** Distância de um ponto a um retângulo orientado (0 se dentro). */
function distPontoOBB(px_: number, pz: number, cx: number, cz: number, yaw: number, hw: number, hl: number): number {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const dx = px_ - cx, dz = pz - cz;
  const l = Math.abs(dx * fx + dz * fz) - hl;
  const t = Math.abs(dx * fz - dz * fx) - hw;
  const ox = Math.max(l, 0), oz = Math.max(t, 0);
  return Math.sqrt(ox * ox + oz * oz);
}

// ---------------------------------------------------------------- grade de calçadas

const CEL = (grade.celulaPx as number) * METROS_POR_PX;
const ORIGEM = px(0, 0);
let _grade: boolean[][] | null = null;
function gradeCalcadas(): boolean[][] {
  return (_grade ??= lerGrade());
}

function elevado(x: number, z: number): boolean {
  const g = gradeCalcadas();
  const cx = Math.floor((x - ORIGEM.x) / CEL);
  const cy = Math.floor((z - ORIGEM.z) / CEL);
  if (cy < 0 || cy >= g.length || cx < 0 || cx >= g[0].length) return true;
  return g[cy][cx];
}

/** Altura do chão (asfalto 0, calçada 0,15). */
function alturaChao(x: number, z: number): number {
  return (elevado(x, z) ? ALTURA_CALCADA : 0) + alturaTerreno(x, z);
}

// ---------------------------------------------------------------- construção das rotas

type P2 = { x: number; z: number; f: number };

function reamostrar(pts: P2[], passo: number, fechada: boolean): P2[] {
  const n = pts.length;
  const segs = fechada ? n : n - 1;
  let total = 0;
  const ac = [0];
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    total += Math.hypot(b.x - a.x, b.z - a.z);
    ac.push(total);
  }
  const m = Math.max(2, Math.round(total / passo));
  const out: P2[] = [];
  const dl = total / (fechada ? m : m - 1);
  let i = 0;
  for (let k = 0; k < m; k++) {
    const s = k * dl;
    while (i < segs - 1 && ac[i + 1] < s) i++;
    const a = pts[i], b = pts[(i + 1) % n];
    const t = Math.min(1, Math.max(0, (s - ac[i]) / (ac[i + 1] - ac[i] || 1e-9)));
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, f: a.f && b.f ? a.f : 0 });
  }
  return out;
}

function faixaComoP2(id: string): P2[] {
  return faixaPorId(id).pontos.map((p) => ({ x: p.x, z: p.z, f: 0 }));
}

/** Empurra pontos para longe do meio-fio (folga mínima `folga`). */
function afastarDoMeioFio(pts: P2[], folga: number, fixos?: (i: number) => boolean): void {
  const r = Math.ceil(folga / CEL);
  for (let i = 0; i < pts.length; i++) {
    if (fixos?.(i)) continue;
    const p = pts[i];
    let melhor = Infinity, vx = 0, vz = 0;
    const cx0 = Math.floor((p.x - ORIGEM.x) / CEL), cy0 = Math.floor((p.z - ORIGEM.z) / CEL);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const qx = ORIGEM.x + (cx0 + dx + 0.5) * CEL;
        const qz = ORIGEM.z + (cy0 + dy + 0.5) * CEL;
        if (!elevado(qx, qz)) continue;
        const d = Math.hypot(p.x - qx, p.z - qz);
        if (d < melhor) { melhor = d; vx = p.x - qx; vz = p.z - qz; }
      }
    }
    if (melhor < folga && melhor > 1e-6) {
      const k = ((folga - melhor) * 0.5) / melhor;
      p.x += vx * k;
      p.z += vz * k;
    }
  }
}

/** Puxa os pontos de `a` que estão a mais de `dmax` de `b` para perto dele. */
function aproximarDe(a: P2[], b: P2[], dmax: number): void {
  for (const p of a) {
    let melhor = Infinity, q = b[0];
    for (const c of b) {
      const d = (p.x - c.x) ** 2 + (p.z - c.z) ** 2;
      if (d < melhor) { melhor = d; q = c; }
    }
    const d = Math.sqrt(melhor);
    if (d > dmax) {
      const k = ((d - dmax) * 0.5) / d;
      p.x += (q.x - p.x) * k;
      p.z += (q.z - p.z) * k;
    }
  }
}

/** Ponto em cima da calçada: vai para a célula de asfalto mais próxima. */
function sairDaCalcada(pts: P2[]): void {
  const r = Math.ceil(3 / CEL);
  for (const p of pts) {
    if (!elevado(p.x, p.z)) continue;
    let melhor = Infinity, bx = p.x, bz = p.z;
    const cx0 = Math.floor((p.x - ORIGEM.x) / CEL), cy0 = Math.floor((p.z - ORIGEM.z) / CEL);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const qx = ORIGEM.x + (cx0 + dx + 0.5) * CEL;
        const qz = ORIGEM.z + (cy0 + dy + 0.5) * CEL;
        if (elevado(qx, qz)) continue;
        const d = (p.x - qx) ** 2 + (p.z - qz) ** 2;
        if (d < melhor) { melhor = d; bx = qx; bz = qz; }
      }
    }
    p.x = bx;
    p.z = bz;
  }
}

/** Afasta `a` de `b` (só `a` se mexe, ou os dois pela metade se `mutuo`). */
function afastarDe(a: P2[], b: P2[], dmin: number, mutuo: boolean, fixos?: (i: number) => boolean): void {
  for (let i = 0; i < a.length; i++) {
    if (fixos?.(i)) continue;
    const p = a[i];
    let melhor = Infinity, j0 = 0;
    for (let j = 0; j < b.length; j++) {
      const d = (p.x - b[j].x) ** 2 + (p.z - b[j].z) ** 2;
      if (d < melhor) { melhor = d; j0 = j; }
    }
    const d = Math.sqrt(melhor);
    if (d < dmin && d > 1e-6) {
      const q = b[j0];
      const k = ((dmin - d) * (mutuo ? 0.5 : 1)) / d;
      const vx = (p.x - q.x) * k, vz = (p.z - q.z) * k;
      p.x += vx;
      p.z += vz;
      if (mutuo) { q.x -= vx; q.z -= vz; }
    }
  }
}

function suavizar(pts: P2[], fechada: boolean, peso = 0.35, fixos?: (i: number) => boolean): void {
  const n = pts.length;
  const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
  for (let i = 0; i < n; i++) {
    if (fixos?.(i)) continue;
    if (!fechada && (i === 0 || i === n - 1)) continue;
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    pts[i].x = xs[i] * (1 - peso) + (xs[a] + xs[b]) * 0.5 * peso;
    pts[i].z = zs[i] * (1 - peso) + (zs[a] + zs[b]) * 0.5 * peso;
  }
}

function indiceMaisProximo(pts: P2[], x: number, z: number): number {
  let m = Infinity, k = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i].x - x) ** 2 + (pts[i].z - z) ** 2;
    if (d < m) { m = d; k = i; }
  }
  return k;
}

function dirEm(pts: P2[], i: number, fechada: boolean): { x: number; z: number } {
  const n = pts.length;
  const a = fechada ? pts[(i - 2 + n) % n] : pts[Math.max(0, i - 2)];
  const b = fechada ? pts[(i + 2) % n] : pts[Math.min(n - 1, i + 2)];
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
}

/** Curva de Bézier cúbica entre dois pontos com tangentes dadas. */
function conector(p0: P2, d0: { x: number; z: number }, p3: P2, d3: { x: number; z: number }): P2[] {
  const dist = Math.hypot(p3.x - p0.x, p3.z - p0.z);
  const k = dist * 0.45;
  const c1 = { x: p0.x + d0.x * k, z: p0.z + d0.z * k };
  const c2 = { x: p3.x - d3.x * k, z: p3.z - d3.z * k };
  const n = Math.max(4, Math.ceil(dist));
  const out: P2[] = [];
  for (let i = 1; i < n; i++) {
    const t = i / n, u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
      z: u * u * u * p0.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t * t * t * p3.z,
      f: 1,
    });
  }
  return out;
}

interface ZonaTrafego {
  zona: Zona;
  tipo: 'faixa' | 'pare' | 'semaforo';
  cx: number;
  cz: number;
  /** Eixo local X (largura) e Z (comprimento) no mundo. */
  axx: number; axz: number;
  azx: number; azz: number;
  hx: number;
  hz: number;
}

function prepararZona(z: Zona, tipo: 'faixa' | 'pare' | 'semaforo'): ZonaTrafego {
  const m = z.inversa.clone().invert();
  const c = new THREE.Vector3().addVectors(z.min, z.max).multiplyScalar(0.5).applyMatrix4(m);
  const e = m.elements;
  const ax = new THREE.Vector3(e[0], 0, e[2]).normalize();
  const az = new THREE.Vector3(e[8], 0, e[10]).normalize();
  return {
    zona: z, tipo, cx: c.x, cz: c.z,
    axx: ax.x, axz: ax.z, azx: az.x, azz: az.z,
    hx: (z.max.x - z.min.x) / 2, hz: (z.max.z - z.min.z) / 2,
  };
}

function localZona(zt: ZonaTrafego, x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
  const dx = x - zt.cx, dz = z - zt.cz;
  out.x = dx * zt.axx + dz * zt.axz;
  out.z = dx * zt.azx + dz * zt.azz;
  return out;
}

interface Intervalo {
  tipo: 'faixa' | 'pare' | 'semaforo';
  zona: number;
  sIni: number;
  sFim: number;
}

interface Rota {
  id: string;
  n: number;
  L: number;
  x: Float32Array;
  z: Float32Array;
  dx: Float32Array;
  dz: Float32Array;
  /** Velocidade máxima em cada amostra (curvas + antecipação de frenagem). */
  perfil: Float32Array;
  /** Seta ligada: +1 direita, −1 esquerda, 0 desligada. */
  seta: Int8Array;
  /** 1 = trecho de conector (entrando/saindo do anel). */
  conector: Uint8Array;
  intervalos: Intervalo[];
  /** Entradas no anel: onde parar para dar a preferência e o ponto de junção. */
  fusoes: { sCeder: number; sJuncao: number; x: number; z: number; dx: number; dz: number }[];
}

function montarRota(id: string, pts: P2[], zonas: ZonaTrafego[]): Rota {
  const r = reamostrar(pts, H, true);
  const n = r.length;
  const rota: Rota = {
    id, n, L: n * H,
    x: new Float32Array(n), z: new Float32Array(n), dx: new Float32Array(n), dz: new Float32Array(n),
    perfil: new Float32Array(n), seta: new Int8Array(n), conector: new Uint8Array(n), intervalos: [], fusoes: [],
  };
  for (let i = 0; i < n; i++) { rota.x[i] = r[i].x; rota.z[i] = r[i].z; }
  for (let i = 0; i < n; i++) {
    const b = (i + 1) % n, a = (i - 1 + n) % n;
    const dx = rota.x[b] - rota.x[a], dz = rota.z[b] - rota.z[a];
    const l = Math.hypot(dx, dz) || 1;
    rota.dx[i] = dx / l;
    rota.dz[i] = dz / l;
  }
  // curvatura → velocidade
  const K = 4;
  for (let i = 0; i < n; i++) {
    const a = (i - K + n) % n, b = (i + K) % n;
    const ang = Math.atan2(rota.dx[a] * rota.dz[b] - rota.dz[a] * rota.dx[b], rota.dx[a] * rota.dx[b] + rota.dz[a] * rota.dz[b]);
    const kappa = Math.abs(ang) / (2 * K * H);
    rota.perfil[i] = Math.max(2.5, Math.min(V_MAX, Math.sqrt(A_LAT / Math.max(kappa, 1e-4))));
  }
  for (let volta = 0; volta < 2; volta++) {
    for (let i = n - 1; i >= 0; i--) {
      const prox = rota.perfil[(i + 1) % n];
      rota.perfil[i] = Math.min(rota.perfil[i], Math.sqrt(prox * prox + 2 * A_CONF * H));
    }
  }
  // seta: nos conectores e 20 m antes deles
  for (let i = 0; i < n; i++) {
    if (!r[i].f) continue;
    rota.conector[i] = 1;
    for (let k = 0; k <= 40; k++) rota.seta[(i - k + n) % n] = r[i].f;
  }
  // trechos dentro de zonas
  const tmp = { x: 0, z: 0 };
  zonas.forEach((zt, zi) => {
    const dentro = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      localZona(zt, rota.x[i], rota.z[i], tmp);
      if (zt.tipo === 'faixa') {
        dentro[i] = Math.abs(tmp.x) <= zt.hx + 0.2 && Math.abs(tmp.z) <= zt.hz ? 1 : 0;
      } else {
        const sentido = rota.dx[i] * zt.azx + rota.dz[i] * zt.azz;
        // linhas de retenção são finas: garante ao menos uma amostra (H = 0,5 m) dentro
        dentro[i] = Math.abs(tmp.x) <= zt.hx + 1.0 && Math.abs(tmp.z) <= Math.max(zt.hz, 0.3) && sentido > 0.5 ? 1 : 0;
      }
    }
    // começa a varrer de um ponto fora
    let i0 = 0;
    while (i0 < n && dentro[i0]) i0++;
    if (i0 >= n) return;
    for (let k = 0; k < n; k++) {
      const i = (i0 + k) % n;
      if (dentro[i] && !dentro[(i - 1 + n) % n]) {
        let j = i;
        while (dentro[(j + 1) % n]) j = (j + 1) % n;
        rota.intervalos.push({ tipo: zt.tipo, zona: zi, sIni: i * H, sFim: ((j + 1) % n) * H });
      }
    }
  });
  return rota;
}

/** Anéis corrigidos (mesmo para todas as instâncias). */
let _aneis: { interno: P2[]; externo: P2[] } | null = null;
function aneisCorrigidos(): { interno: P2[]; externo: P2[] } {
  if (_aneis) return _aneis;
  const interno = reamostrar(faixaComoP2('anel_interno'), 1, true);
  const externo = reamostrar(faixaComoP2('anel_externo'), 1, true);
  // Mão dupla: as duas faixas ficam lado a lado (nem coladas, nem uma
  // escapando pelo estacionamento), longe do meio-fio e suaves.
  for (let it = 0; it < 60; it++) {
    afastarDe(interno, externo, 3.6, true);
    aproximarDe(externo, interno, 4.4);
    sairDaCalcada(interno);
    sairDaCalcada(externo);
    afastarDoMeioFio(interno, 1.6);
    afastarDoMeioFio(externo, 1.6);
    suavizar(interno, true);
    suavizar(externo, true);
  }
  for (let it = 0; it < 12; it++) {
    suavizar(externo, true, 0.6);
    suavizar(interno, true, 0.3);
    afastarDe(interno, externo, 3.6, true);
    sairDaCalcada(interno);
    sairDaCalcada(externo);
    afastarDoMeioFio(interno, 1.5);
    afastarDoMeioFio(externo, 1.5);
  }
  _aneis = { interno, externo };
  return _aneis;
}

/**
 * Rotas que sobem a avenida diagonal e voltam ao começo dela pelo anel:
 *  - diagonal_2 (faixa do meio, seta para a direita): vira à direita no anel
 *    interno (horário), desce pela direita e entra de novo na diagonal.
 *  - diagonal_1 (faixa da esquerda, seta para a esquerda): vira à esquerda no
 *    anel externo (anti-horário), dá a volta pela esquerda e por baixo e
 *    entra na diagonal à esquerda.
 */
const LACOS: Record<string, { anel: 'interno' | 'externo'; avanco: number; recuo: number }> = {
  diagonal_1: { anel: 'externo', avanco: 8, recuo: 11 },
  diagonal_2: { anel: 'interno', avanco: 12, recuo: 9 },
  diagonal_3: { anel: 'interno', avanco: 16, recuo: 7 },
};

function pontosRota(id: string): P2[] {
  const { interno, externo } = aneisCorrigidos();
  if (id === 'anel_externo') return externo.map((p) => ({ ...p }));
  if (id === 'anel_interno') return interno.map((p) => ({ ...p }));
  const cfg = LACOS[id];
  const anel = cfg.anel === 'interno' ? interno : externo;
  const diag = reamostrar(faixaComoP2(id), 1, false);
  const ini = diag[0], fim = diag[diag.length - 1];
  const dIni = dirEm(diag, 0, false), dFim = dirEm(diag, diag.length - 1, false);
  const n = anel.length; // 1 m por ponto
  // entrada no anel: `avanco` m depois do ponto do anel mais perto de “fim + 10 m”
  const iEntra = (indiceMaisProximo(anel, fim.x + dFim.x * 10, fim.z + dFim.z * 10) + cfg.avanco) % n;
  // saída do anel: `recuo` m antes do ponto do anel mais perto do começo da diagonal
  const iSai = (indiceMaisProximo(anel, ini.x, ini.z) - cfg.recuo + n) % n;
  const pts: P2[] = diag.map((p) => ({ ...p }));
  const ligar = (p0: P2, d0: { x: number; z: number }, p1: P2, d1: { x: number; z: number }) => {
    // lado da curva (para a seta): + direita, − esquerda (direita de quem anda em d = (−d.z, d.x))
    const lado = Math.sign(d1.x * -d0.z + d1.z * d0.x) || 1;
    for (const q of conector(p0, d0, p1, d1)) pts.push({ ...q, f: lado });
  };
  ligar(fim, dFim, anel[iEntra], dirEm(anel, iEntra, true));
  for (let i = iEntra; i !== iSai; i = (i + 1) % n) pts.push({ ...anel[i], f: 0 });
  pts.push({ ...anel[iSai], f: 0 });
  ligar(anel[iSai], dirEm(anel, iSai, true), ini, dIni);
  const tot = pts.length;
  // corrige: longe do meio-fio (e da mão contrária); o trecho do anel fica como está
  const fixo = (i: number) => i > diag.length + 6 && i < tot - 6 && pts[i].f === 0;
  for (let it = 0; it < 25; it++) {
    afastarDoMeioFio(pts, 1.6, fixo);
    suavizar(pts, true, 0.35, fixo);
    if (cfg.anel === 'interno') afastarDe(pts, externo, 3.8, false, fixo);
  }
  return pts;
}

/** Acha onde cada conector desemboca no anel e o ponto, antes, em que o carro ainda está fora da faixa. */
function marcarFusoes(rota: Rota, anel: Rota): void {
  const distAnel = (i: number) => {
    let m = Infinity;
    for (let k = 0; k < anel.n; k++) m = Math.min(m, (rota.x[i] - anel.x[k]) ** 2 + (rota.z[i] - anel.z[k]) ** 2);
    return Math.sqrt(m);
  };
  for (let i = 0; i < rota.n; i++) {
    const j = (i + 1) % rota.n;
    if (!rota.conector[i] || rota.conector[j]) continue;
    if (distAnel(j) > 0.6) continue; // desemboca na diagonal, não no anel
    let c = i;
    for (let k = 0; k < 60 && rota.conector[c] && distAnel(c) < 3.4; k++) c = (c - 1 + rota.n) % rota.n;
    rota.fusoes.push({ sCeder: c * H, sJuncao: j * H, x: rota.x[j], z: rota.z[j], dx: rota.dx[j], dz: rota.dz[j] });
  }
}

// ---------------------------------------------------------------- estado

interface VisualCarro {
  raiz: THREE.Group;
  rodas: THREE.Object3D[];
  freio: THREE.MeshStandardMaterial;
  setaDir: THREE.MeshStandardMaterial;
  setaEsq: THREE.MeshStandardMaterial;
}

interface CarroIA {
  i: number;
  rota: Rota;
  s: number;
  v: number;
  vMax: number;
  acel: number;
  x: number;
  z: number;
  yaw: number;
  /** Inclinação (rad, + = nariz para cima) na rampa. */
  arfagem: number;
  /** Frente (unitária). */
  fx: number;
  fz: number;
  freando: boolean;
  /** Intervalo de PARE já cumprido (índice) ou −1. */
  pareCumprido: number;
  parado: number;
  contato: boolean;
  giroRodas: number;
  corpo: RAPIER.RigidBody;
  inicial: { rota: Rota; s: number };
  visual?: VisualCarro;
}

type EstadoPed = 'esperando' | 'atravessando' | 'caido';

interface VisualPed {
  raiz: THREE.Group;
  pernaE: THREE.Object3D;
  pernaD: THREE.Object3D;
  bracoE: THREE.Object3D;
  bracoD: THREE.Object3D;
  corpo: THREE.Object3D;
}

interface Pedestre {
  zona: number;
  /** Lado onde está (+1 / −1 ao longo do eixo Z da zona). */
  lado: number;
  /** Deslocamento lateral (eixo X da zona). */
  desloc: number;
  /** 0..1 ao longo da travessia. */
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vel: number;
  estado: EstadoPed;
  espera: number;
  tempoCaido: number;
  queda: number;
  fase: number;
  travessias: number;
  contato: boolean;
  corpo: RAPIER.RigidBody;
  colisor: RAPIER.Collider;
  inicial: { lado: number; desloc: number; espera: number };
  visual?: VisualPed;
}

const _q = new THREE.Quaternion();
const _eixoY = new THREE.Vector3(0, 1, 0);
const _eixoX = new THREE.Vector3(1, 0, 0);
const _qArf = new THREE.Quaternion();
const _loc = { x: 0, z: 0 };

// ---------------------------------------------------------------- classe

export class Trafego {
  readonly grupo = new THREE.Group();
  private readonly sim: Simulacao;
  private readonly rotas = new Map<string, Rota>();
  private readonly zonas: ZonaTrafego[] = [];
  private readonly carros: CarroIA[] = [];
  private readonly pedestres: Pedestre[] = [];
  private readonly eventos: InfoTrafego['eventos'] = [];
  private readonly visuais: boolean;
  private readonly sorteio: () => number;
  /** gap[i*n+j]: folga do carro i até o carro j à frente (Infinity se não vê). */
  private gaps = new Float64Array(0);
  /** lats[i*n+j]: distância lateral do carro j até o caminho do carro i. */
  private lats = new Float64Array(0);
  private ocupada: Uint8Array;
  private tempo = 0;
  // estado do carro do jogador neste passo
  private jx = 0;
  private jz = 0;
  private jyaw = 0;
  private jvx = 0;
  private jvz = 0;
  private readonly jhw: number;
  private readonly jhl: number;
  // saída de info()
  private readonly infoPed: InfoTrafego['pedestres'] = [];
  private readonly infoCarros: InfoTrafego['carros'] = [];
  // projeção (saída de projetar)
  private _ds = 0;
  private _lat = 0;
  private _k = 0;

  /** Passagem de nível fechada (trem vindo): quem está no PARE dos trilhos espera. */
  passagemBloqueada: () => boolean = () => false;

  constructor(sim: Simulacao, opcoes: OpcoesTrafego = {}) {
    this.sim = sim;
    this.visuais = opcoes.visuais ?? true;
    this.sorteio = criarSorteio(opcoes.semente ?? 20261114);
    this.grupo.name = 'trafego';
    const cb = sim.carro.cfg.carroceria;
    this.jhw = cb.meiaLargura;
    this.jhl = cb.meiaComprimento;

    for (const z of sim.mapa.zonas) {
      if (z.tipo === 'faixa_pedestre') this.zonas.push(prepararZona(z, 'faixa'));
      else if (z.tipo === 'pare') this.zonas.push(prepararZona(z, 'pare'));
      else if (z.tipo === 'linha_parada') this.zonas.push(prepararZona(z, 'semaforo'));
    }
    this.ocupada = new Uint8Array(this.zonas.length);
    for (const id of ['anel_externo', 'anel_interno', 'diagonal_1', 'diagonal_2', 'diagonal_3']) {
      this.rotas.set(id, montarRota(id, pontosRota(id), this.zonas));
    }
    for (const [id, cfg] of Object.entries(LACOS)) marcarFusoes(this.rotas.get(id)!, this.rotas.get(`anel_${cfg.anel}`)!);

    this.criarCarros(opcoes.carros ?? 6);
    this.criarPedestres(opcoes.pedestres ?? 6);
    this.lerJogador();
  }

  // ------------------------------------------------------------ criação

  private criarCarros(qtd: number): void {
    const spawn = this.sim.mapa.spawn.posicao;
    const baliza = this.sim.mapa.zonas.find((z) => z.tipo === 'baliza')?.centro;
    const colocados: { x: number; z: number }[] = [];
    for (let i = 0; i < qtd; i++) {
      const rota = this.rotas.get(ROTAS_USADAS[i % ROTAS_USADAS.length])!;
      let s = 0;
      for (let tent = 0; tent < 2000; tent++) {
        s = Math.floor(this.sorteio() * rota.n) * H;
        const k = Math.floor(s / H);
        const x = rota.x[k], z = rota.z[k];
        const espaco = tent < 1500 ? 14 : 8;
        if (Math.hypot(x - spawn.x, z - spawn.z) < 25) continue;
        if (baliza && Math.hypot(x - baliza.x, z - baliza.z) < 25) continue;
        if (colocados.some((c) => Math.hypot(c.x - x, c.z - z) < espaco)) continue;
        if (rota.intervalos.some((iv) => mod(s - iv.sIni, rota.L) < mod(iv.sFim - iv.sIni, rota.L) + 6 || mod(iv.sIni - s, rota.L) < 10)) continue;
        break;
      }
      const k = Math.floor(s / H);
      colocados.push({ x: rota.x[k], z: rota.z[k] });

      const corpo = this.sim.mundo.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      this.sim.mundo.createCollider(
        RAPIER.ColliderDesc.cuboid(CARRO_MEIA_LARG, CARRO_MEIA_ALT, CARRO_MEIO_COMP).setFriction(0.6).setRestitution(0.05),
        corpo,
      );
      const c: CarroIA = {
        i, rota, s, v: 0,
        vMax: V_MAX * (0.82 + 0.18 * this.sorteio()),
        acel: 1.6 + 0.6 * this.sorteio(),
        x: 0, z: 0, yaw: 0, fx: 0, fz: 1,
        freando: false, arfagem: 0, pareCumprido: -1, parado: 0, contato: false, giroRodas: 0,
        corpo, inicial: { rota, s },
      };
      if (this.visuais) {
        c.visual = criarVisualCarro(CORES_CARRO[Math.floor(this.sorteio() * CORES_CARRO.length)]);
        this.grupo.add(c.visual.raiz);
      }
      this.carros.push(c);
      this.posicionarCarro(c, true);
    }
    this.gaps = new Float64Array(qtd * qtd);
    this.lats = new Float64Array(qtd * qtd);
  }

  private criarPedestres(qtd: number): void {
    const faixas = this.zonas.map((z, i) => ({ z, i })).filter((o) => o.z.tipo === 'faixa');
    if (!faixas.length) return;
    for (let i = 0; i < qtd; i++) {
      const { z: zt, i: zi } = faixas[i % faixas.length];
      const lado = Math.floor(i / faixas.length) % 2 === 0 ? -1 : 1;
      const desloc = (this.sorteio() * 2 - 1) * Math.max(0, zt.hx - 0.5);
      const espera = 1 + this.sorteio() * 5;
      const corpo = this.sim.mundo.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      const colisor = this.sim.mundo.createCollider(RAPIER.ColliderDesc.capsule(PED_MEIA_ALT, PED_RAIO).setFriction(0.5), corpo);
      const p: Pedestre = {
        zona: zi, lado, desloc, t: 0, x: 0, y: 0, z: 0, yaw: 0,
        vel: PED_VEL * (0.88 + 0.24 * this.sorteio()),
        estado: 'esperando', espera, tempoCaido: 0, queda: 0, fase: this.sorteio() * 6,
        travessias: 0, contato: false, corpo, colisor,
        inicial: { lado, desloc, espera },
      };
      if (this.visuais) {
        p.visual = criarVisualPedestre(this.sorteio);
        this.grupo.add(p.visual.raiz);
      }
      this.pedestres.push(p);
      this.posicionarPedestre(p, true);
    }
  }

  // ------------------------------------------------------------ API

  /** Coloca o carro `indice` numa rota (`anel_externo`, `diagonal_2`…) a `s` m do início. Útil para testes/cenários. */
  colocarCarro(indice: number, rotaId: string, s: number, velocidade = 0): void {
    const c = this.carros[indice];
    const rota = this.rotas.get(rotaId);
    if (!c || !rota) throw new Error(`carro ${indice} ou rota ${rotaId} inexistente`);
    c.rota = rota;
    c.s = mod(s, rota.L);
    c.v = velocidade;
    c.pareCumprido = -1;
    c.parado = 0;
    this.posicionarCarro(c, true);
  }

  /** Ponto (x, z) e yaw de uma rota a `s` m do início. */
  pontoDaRota(rotaId: string, s: number): { x: number; z: number; yaw: number } {
    const r = this.rotas.get(rotaId);
    if (!r) throw new Error(`rota ${rotaId} inexistente`);
    const k = Math.floor(mod(s, r.L) / H);
    return { x: r.x[k], z: r.z[k], yaw: Math.atan2(r.dx[k], r.dz[k]) };
  }

  /** Estado detalhado dos carros (para testes e depuração). */
  estadoCarros(): { x: number; z: number; yaw: number; v: number; meiaLargura: number; meioComprimento: number; rota: string; s: number }[] {
    return this.carros.map((c) => ({
      x: c.x, z: c.z, yaw: c.yaw, v: c.v, meiaLargura: CARRO_MEIA_LARG, meioComprimento: CARRO_MEIO_COMP, rota: c.rota.id, s: c.s,
    }));
  }

  /** Quantas travessias completas os pedestres já fizeram. */
  travessias(): number {
    let n = 0;
    for (const p of this.pedestres) n += p.travessias;
    return n;
  }

  passo(dt: number): void {
    this.tempo += dt;
    this.lerJogador();
    this.verificarContatos();
    this.passoPedestres(dt);
    this.passoCarros(dt);
  }

  atualizarVisual(dt: number): void {
    if (!this.visuais) return;
    const pisca = Math.floor(this.tempo * 2.6) % 2 === 0;
    for (const c of this.carros) {
      const v = c.visual;
      if (!v) continue;
      v.raiz.position.set(c.x, alturaTerreno(c.x, c.z), c.z);
      v.raiz.rotation.set(-c.arfagem, c.yaw, 0, 'YXZ');
      for (const r of v.rodas) r.rotation.x = c.giroRodas;
      v.freio.emissiveIntensity = c.freando ? 2.6 : 0.35;
      const seta = pisca ? c.rota.seta[Math.floor(c.s / H) % c.rota.n] : 0;
      v.setaDir.emissiveIntensity = seta > 0 ? 3 : 0;
      v.setaEsq.emissiveIntensity = seta < 0 ? 3 : 0;
    }
    for (const p of this.pedestres) {
      const v = p.visual;
      if (!v) continue;
      if (p.estado === 'atravessando') p.fase += dt * p.vel * 4.2;
      const andando = p.estado === 'atravessando';
      const sw = andando ? Math.sin(p.fase) : 0;
      v.pernaE.rotation.x = sw * 0.5;
      v.pernaD.rotation.x = -sw * 0.5;
      v.bracoE.rotation.x = -sw * 0.4;
      v.bracoD.rotation.x = sw * 0.4;
      v.corpo.position.y = andando ? Math.abs(Math.cos(p.fase)) * 0.03 : Math.sin(this.tempo * 1.7 + p.fase) * 0.006;
      v.raiz.position.set(p.x, p.y, p.z);
      v.raiz.rotation.set(0, p.yaw, 0);
      if (p.queda > 0) {
        // cai para trás, girando em torno dos pés
        v.raiz.rotateX(-p.queda * Math.PI * 0.48);
        v.raiz.position.y = p.y + 0.12 * p.queda;
      }
    }
  }

  info(): InfoTrafego {
    while (this.infoPed.length < this.pedestres.length) this.infoPed.push({ posicao: new THREE.Vector3(), naFaixa: null });
    this.infoPed.length = this.pedestres.length;
    this.pedestres.forEach((p, i) => {
      const o = this.infoPed[i];
      o.posicao.set(p.x, p.y, p.z);
      o.naFaixa = null;
      for (const zt of this.zonas) {
        if (zt.tipo !== 'faixa') continue;
        localZona(zt, p.x, p.z, _loc);
        if (Math.abs(_loc.x) <= zt.hx && Math.abs(_loc.z) <= zt.hz) { o.naFaixa = zt.zona.nome; break; }
      }
    });
    while (this.infoCarros.length < this.carros.length) this.infoCarros.push({ posicao: new THREE.Vector3(), velocidade: 0 });
    this.infoCarros.length = this.carros.length;
    this.carros.forEach((c, i) => {
      this.infoCarros[i].posicao.set(c.x, CARRO_Y + alturaTerreno(c.x, c.z), c.z);
      this.infoCarros[i].velocidade = c.v;
    });
    return { pedestres: this.infoPed, carros: this.infoCarros, eventos: this.eventos.splice(0) };
  }

  reiniciar(): void {
    this.eventos.length = 0;
    for (const c of this.carros) {
      c.rota = c.inicial.rota;
      c.s = c.inicial.s;
      c.v = 0;
      c.pareCumprido = -1;
      c.parado = 0;
      c.contato = false;
      c.freando = false;
      this.posicionarCarro(c, true);
    }
    for (const p of this.pedestres) {
      p.lado = p.inicial.lado;
      p.desloc = p.inicial.desloc;
      p.espera = p.inicial.espera;
      p.estado = 'esperando';
      p.t = 0;
      p.queda = 0;
      p.tempoCaido = 0;
      p.contato = false;
      p.colisor.setEnabled(true);
      this.posicionarPedestre(p, true);
    }
  }

  liberar(): void {
    for (const c of this.carros) this.sim.mundo.removeRigidBody(c.corpo);
    for (const p of this.pedestres) this.sim.mundo.removeRigidBody(p.corpo);
    this.carros.length = 0;
    this.pedestres.length = 0;
    this.grupo.removeFromParent();
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    this.grupo.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      geos.add(m.geometry);
      for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x);
    });
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    this.grupo.clear();
  }

  // ------------------------------------------------------------ jogador

  private lerJogador(): void {
    const corpo = this.sim.carro.corpo;
    const t = corpo.translation();
    const r = corpo.rotation();
    const fx = 2 * (r.x * r.z + r.w * r.y);
    const fz = 1 - 2 * (r.x * r.x + r.y * r.y);
    this.jyaw = Math.atan2(fx, fz);
    const c = this.sim.carro.cfg.carroceria.centro;
    // centro do colisor (deslocado para trás no Mobi/Kwid)
    const s = Math.sin(this.jyaw), co = Math.cos(this.jyaw);
    this.jx = t.x + c[0] * co + c[2] * s;
    this.jz = t.z - c[0] * s + c[2] * co;
    const lv = corpo.linvel();
    this.jvx = lv.x;
    this.jvz = lv.z;
  }

  private verificarContatos(): void {
    for (const c of this.carros) {
      const sep = separacaoOBB(c.x, c.z, c.yaw, CARRO_MEIA_LARG, CARRO_MEIO_COMP, this.jx, this.jz, this.jyaw, this.jhw, this.jhl);
      if (!c.contato && sep < 0.03) {
        c.contato = true;
        this.eventos.push('colisao_carro');
      } else if (c.contato && sep > 0.25) c.contato = false;
    }
    for (const p of this.pedestres) {
      const d = distPontoOBB(p.x, p.z, this.jx, this.jz, this.jyaw, this.jhw, this.jhl) - PED_RAIO;
      if (!p.contato && d < 0.05 && p.estado !== 'caido') {
        p.contato = true;
        this.eventos.push('atropelou_pedestre');
        p.estado = 'caido';
        p.tempoCaido = 0;
        p.colisor.setEnabled(false);
      } else if (p.contato && d > 0.5) p.contato = false;
    }
  }

  // ------------------------------------------------------------ pedestres

  private posicionarPedestre(p: Pedestre, teleporte: boolean): void {
    const zt = this.zonas[p.zona];
    const margem = 0.75;
    const zIni = p.lado * (zt.hz + margem);
    const lz = zIni + (-2 * zIni) * p.t;
    const lx = p.desloc;
    p.x = zt.cx + zt.axx * lx + zt.azx * lz;
    p.z = zt.cz + zt.axz * lx + zt.azz * lz;
    p.y = alturaChao(p.x, p.z);
    // olha para o outro lado
    const dir = -p.lado;
    p.yaw = Math.atan2(zt.azx * dir, zt.azz * dir);
    const yc = p.y + PED_MEIA_ALT + PED_RAIO + 0.02;
    _q.setFromAxisAngle(_eixoY, p.yaw);
    if (teleporte) {
      p.corpo.setTranslation({ x: p.x, y: yc, z: p.z }, true);
      p.corpo.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    } else {
      p.corpo.setNextKinematicTranslation({ x: p.x, y: yc, z: p.z });
      p.corpo.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    }
  }

  /** Algum veículo chega à faixa em menos de ~2 s (ou já está nela)? */
  private veiculoChegando(zi: number): boolean {
    const zt = this.zonas[zi];
    const perto = (x: number, z: number, vx: number, vz: number, meioComp: number): boolean => {
      localZona(zt, x, z, _loc);
      if (Math.abs(_loc.z) > zt.hz + 1.5) return false;
      const dx = Math.max(0, Math.abs(_loc.x) - zt.hx) - meioComp;
      if (dx <= 0.3) return true;
      const vLocal = vx * zt.axx + vz * zt.axz;
      const vAprox = -Math.sign(_loc.x) * vLocal;
      const vel = Math.hypot(vx, vz);
      if (dx < 4 && vel > 0.5) return true;
      return vAprox > 0.3 && dx / vAprox < 2.0;
    };
    if (perto(this.jx, this.jz, this.jvx, this.jvz, this.jhl)) return true;
    for (const c of this.carros) if (perto(c.x, c.z, c.fx * c.v, c.fz * c.v, CARRO_MEIO_COMP)) return true;
    return false;
  }

  private passoPedestres(dt: number): void {
    this.ocupada.fill(0);
    for (const p of this.pedestres) {
      const zt = this.zonas[p.zona];
      const largura = 2 * (zt.hz + 0.75);
      if (p.estado === 'esperando') {
        p.espera -= dt;
        if (p.espera <= 0 && !this.veiculoChegando(p.zona)) {
          p.estado = 'atravessando';
          p.t = 0;
        }
      } else if (p.estado === 'atravessando') {
        p.t += (p.vel * dt) / largura;
        if (p.t >= 1) {
          p.t = 0;
          p.lado = -p.lado;
          p.estado = 'esperando';
          p.espera = 3 + this.sorteio() * 9;
          p.desloc = (this.sorteio() * 2 - 1) * Math.max(0, zt.hx - 0.5);
          p.travessias++;
        }
      } else {
        p.tempoCaido += dt;
        p.queda = Math.min(1, p.queda + dt / 0.45);
        if (p.tempoCaido > 6) {
          // levanta e termina a travessia (ou volta para a calçada)
          p.queda = 0;
          p.colisor.setEnabled(true);
          p.estado = p.t > 0 ? 'atravessando' : 'esperando';
          p.espera = 2;
        }
      }
      if (p.estado !== 'caido' && p.queda > 0) p.queda = Math.max(0, p.queda - dt * 2);
      if (p.estado === 'atravessando' || (p.estado === 'caido' && p.t > 0)) this.ocupada[p.zona] = 1;
      this.posicionarPedestre(p, false);
    }
  }

  // ------------------------------------------------------------ carros

  private posicionarCarro(c: CarroIA, teleporte: boolean): void {
    const r = c.rota;
    const k = Math.floor(c.s / H) % r.n;
    const t = c.s / H - Math.floor(c.s / H);
    const k1 = (k + 1) % r.n;
    c.x = r.x[k] + (r.x[k1] - r.x[k]) * t;
    c.z = r.z[k] + (r.z[k1] - r.z[k]) * t;
    // direção pela corda entre o eixo traseiro e o dianteiro (suave nas emendas)
    const a = (k - 2 + r.n) % r.n, b = (k + 3) % r.n;
    const dx = r.x[b] - r.x[a], dz = r.z[b] - r.z[a];
    const l = Math.hypot(dx, dz) || 1;
    c.fx = dx / l;
    c.fz = dz / l;
    c.yaw = Math.atan2(c.fx, c.fz);
    // relevo (rampa): sobe o carro e inclina pelo declive entre os eixos
    const hT = alturaTerreno(c.x, c.z);
    const hF = alturaTerreno(c.x + c.fx * 1.2, c.z + c.fz * 1.2);
    const hR = alturaTerreno(c.x - c.fx * 1.2, c.z - c.fz * 1.2);
    c.arfagem = Math.atan2(hF - hR, 2.4);
    _q.setFromAxisAngle(_eixoY, c.yaw).multiply(_qArf.setFromAxisAngle(_eixoX, -c.arfagem));
    const y = CARRO_Y + hT;
    if (teleporte) {
      c.corpo.setTranslation({ x: c.x, y, z: c.z }, true);
      c.corpo.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    } else {
      c.corpo.setNextKinematicTranslation({ x: c.x, y, z: c.z });
      c.corpo.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    }
  }

  /**
   * Projeta (ox, oz) no trecho da rota do carro à frente dele (até OLHAR m).
   * Preenche _ds (distância ao longo da rota, centro a centro), _lat e _k.
   */
  private projetar(c: CarroIA, ox: number, oz: number): boolean {
    const dx0 = ox - c.x, dz0 = oz - c.z;
    if (dx0 * dx0 + dz0 * dz0 > (OLHAR + 4) * (OLHAR + 4)) return false;
    const r = c.rota;
    const i0 = Math.floor(c.s / H);
    let melhor = Infinity, km = 0;
    for (let k = 0; k <= N_OLHAR; k++) {
      const i = (i0 + k) % r.n;
      const dx = ox - r.x[i], dz = oz - r.z[i];
      const d = dx * dx + dz * dz;
      if (d < melhor) { melhor = d; km = k; }
    }
    if (km === 0) {
      // atrás ou ao lado: só conta se estiver à frente do centro
      const proj = dx0 * c.fx + dz0 * c.fz;
      if (proj < 0) return false;
      this._ds = proj;
    } else this._ds = km * H - (c.s - i0 * H);
    this._lat = Math.sqrt(melhor);
    this._k = (i0 + km) % r.n;
    return true;
  }

  /** Folga até um obstáculo retangular (Infinity se não está no caminho). */
  private folgaAte(c: CarroIA, ox: number, oz: number, oyaw: number, ohw: number, ohl: number): number {
    if (!this.projetar(c, ox, oz)) return Infinity;
    const r = c.rota;
    const cosD = Math.abs(r.dx[this._k] * Math.sin(oyaw) + r.dz[this._k] * Math.cos(oyaw));
    const sinD = Math.sqrt(Math.max(0, 1 - cosD * cosD));
    const limLat = CARRO_MEIA_LARG + cosD * ohw + sinD * ohl + 0.3;
    if (this._lat > limLat) return Infinity;
    return this._ds - CARRO_MEIO_COMP - (cosD * ohl + sinD * ohw);
  }

  private passoCarros(dt: number): void {
    const n = this.carros.length;
    const gaps = this.gaps;
    const lats = this.lats;
    // quem vê quem à frente
    for (let i = 0; i < n; i++) {
      const c = this.carros[i];
      for (let j = 0; j < n; j++) {
        if (i === j) { gaps[i * n + j] = Infinity; continue; }
        const o = this.carros[j];
        gaps[i * n + j] = this.folgaAte(c, o.x, o.z, o.yaw, CARRO_MEIA_LARG, CARRO_MEIO_COMP);
        lats[i * n + j] = this._lat;
      }
    }
    for (let i = 0; i < n; i++) {
      const c = this.carros[i];
      const r = c.rota;
      const k = Math.floor(c.s / H) % r.n;
      let alvo = Math.min(c.vMax, r.perfil[k]);
      let folgaMin = Infinity;
      const limitar = (folga: number, vLider: number, distMin: number) => {
        folgaMin = Math.min(folgaMin, folga - distMin);
        const g = folga - distMin;
        const vl = g <= 0 ? 0 : Math.sqrt(vLider * vLider + 2 * A_CONF * g);
        if (vl < alvo) alvo = vl;
      };

      // outros carros
      for (let j = 0; j < n; j++) {
        const g = gaps[i * n + j];
        if (g === Infinity) continue;
        // Os dois se veem (caminhos convergindo): tem preferência quem já está
        // mais “dentro” do caminho do outro; empate → quem está no anel (não no
        // conector), depois quem está mais perto. Quem tem a preferência só
        // ignora o outro se der para passar sem encostar nele.
        if (gaps[j * n + i] !== Infinity && lats[i * n + j] >= 2 * CARRO_MEIA_LARG + 0.1 && this.temPreferencia(i, j)) continue;
        const o = this.carros[j];
        const vl = Math.max(0, o.v * (o.fx * c.fx + o.fz * c.fz));
        limitar(g, vl, DIST_SEGURA + 0.6 * c.v);
      }
      // jogador
      const gj = this.folgaAte(c, this.jx, this.jz, this.jyaw, this.jhw, this.jhl);
      if (gj !== Infinity) {
        const vl = Math.max(0, this.jvx * c.fx + this.jvz * c.fz);
        limitar(gj, vl, DIST_SEGURA + 0.6 * c.v);
      }
      // pedestres na pista à frente
      for (const p of this.pedestres) {
        if (p.estado === 'esperando') continue;
        const g = this.folgaAte(c, p.x, p.z, p.yaw, PED_RAIO + 0.4, PED_RAIO + 0.4);
        if (g !== Infinity) limitar(g, 0, 2);
      }
      // entrada no anel: dá a preferência a quem já vem nele
      for (const f of r.fusoes) {
        const d = mod(f.sCeder - (c.s + CARRO_MEIO_COMP), r.L);
        const dJ = mod(f.sJuncao - c.s, r.L);
        // entre a linha de ceder e a junção (ex.: parado na faixa de pedestres)
        const entre = dJ < mod(f.sJuncao - f.sCeder, r.L) + CARRO_MEIO_COMP;
        if (!entre && d > OLHAR) continue;
        if (entre && c.v > 1) continue; // já está entrando: segue
        const tEu = dJ / Math.max(c.v, 2);
        for (const o of this.carros) {
          if (o === c || o.rota.conector[Math.floor(o.s / H) % o.rota.n]) continue;
          // só quem anda no mesmo sentido do anel na junção (a mão contrária não conta)
          if (o.fx * f.dx + o.fz * f.dz < 0.3) continue;
          const perto = (o.x - f.x) ** 2 + (o.z - f.z) ** 2 < 7 * 7;
          let ceder = perto;
          if (!ceder && this.projetar(o, f.x, f.z) && this._lat < 1.2) {
            ceder = this._ds < 8 || this._ds / Math.max(o.v, 0.5) < tEu + 2.2;
          }
          if (ceder) { limitar(entre ? 0 : d, 0, 0); break; }
        }
      }
      // faixas de pedestres ocupadas e PARE
      for (let q = 0; q < r.intervalos.length; q++) {
        const iv = r.intervalos[q];
        const frente = c.s + CARRO_MEIO_COMP;
        if (iv.tipo === 'faixa') {
          if (!this.ocupada[iv.zona]) continue;
          const compr = mod(iv.sFim - iv.sIni, r.L);
          if (mod(frente - iv.sIni, r.L) < compr) continue; // já está na faixa: segue
          const d = mod(iv.sIni - frente, r.L);
          if (d < OLHAR) limitar(d, 0, 1.2);
        } else if (iv.tipo === 'semaforo') {
          // Semáforo: para na linha no vermelho; no amarelo só se ainda der para parar.
          const zt = this.zonas[iv.zona];
          const sem = this.sim.mapa.semaforos.find((x) => x.id === zt.zona.id);
          if (!sem) continue;
          const cor = corSemaforo(sem, this.sim.tempo);
          if (cor === 'verde') continue;
          const rel = mod(iv.sIni - c.s, r.L);
          if (rel > r.L / 2) continue; // já passou
          const d = rel - CARRO_MEIO_COMP - 0.3;
          if (d < 0) continue; // já está sobre a linha: segue
          if (cor === 'amarelo' && d < (c.v * c.v) / (2 * A_FREIO) + 1) continue;
          if (d < OLHAR + 5) limitar(d, 0, 0);
        } else {
          const rel = mod(iv.sFim - c.s, r.L);
          if (rel > r.L / 2) {
            if (c.pareCumprido === q) c.pareCumprido = -1;
            continue;
          }
          if (c.pareCumprido === q) continue;
          const d = rel - CARRO_MEIO_COMP - 0.3;
          if (d < -0.5) { c.pareCumprido = q; continue; }
          if (d > OLHAR + 5) continue;
          limitar(d, 0, 0);
          if (c.v < 0.15 && d < 1.5) {
            c.parado += dt;
            const pn = this.zonas[iv.zona].zona.nome.toUpperCase().includes('PN');
            if (c.parado >= TEMPO_PARE && this.livreAposPare(c, iv) && !(pn && this.passagemBloqueada())) {
              c.pareCumprido = q;
              c.parado = 0;
            }
          }
        }
      }

      // dinâmica longitudinal
      if (alvo > c.v) {
        c.v = Math.min(alvo, c.v + c.acel * dt);
        c.freando = c.v < 0.05;
      } else {
        const queda = c.v - alvo;
        const a = folgaMin < 0.5 || queda > 2 ? A_EMERG : A_FREIO;
        c.v = Math.max(alvo, c.v - a * dt);
        c.freando = queda > 0.02 || c.v < 0.05;
      }
      if (c.v < 1e-3) c.v = 0;
      c.s = mod(c.s + c.v * dt, r.L);
      c.giroRodas += (c.v * dt) / 0.29;
      if (c.giroRodas > Math.PI * 2) c.giroRodas -= Math.PI * 2;
      this.posicionarCarro(c, false);
    }
  }

  private temPreferencia(i: number, j: number): boolean {
    const n = this.carros.length;
    const eu = this.lats[j * n + i]; // eu no caminho dele
    const ele = this.lats[i * n + j]; // ele no meu caminho
    if (Math.abs(eu - ele) > 0.3) return eu < ele;
    const a = this.carros[i], b = this.carros[j];
    const ca = a.rota.conector[Math.floor(a.s / H) % a.rota.n], cb = b.rota.conector[Math.floor(b.s / H) % b.rota.n];
    if (ca !== cb) return !ca;
    const g = this.gaps[i * n + j], gInv = this.gaps[j * n + i];
    if (Math.abs(g - gInv) > 0.01) return g < gInv;
    return i < j;
  }

  /** Depois do PARE: ninguém por perto do ponto logo depois da linha. */
  private livreAposPare(c: CarroIA, iv: Intervalo): boolean {
    const r = c.rota;
    const k = Math.floor(mod(iv.sFim + 5, r.L) / H);
    const px_ = r.x[k], pz = r.z[k];
    // atrapalha: quem está andando perto do ponto logo depois da linha, ou
    // parado em cima dele
    const atrapalha = (x: number, z: number, v: number) => {
      const d2 = (x - px_) ** 2 + (z - pz) ** 2;
      return d2 < 3.5 * 3.5 || (v > 0.5 && d2 < 7 * 7);
    };
    if (atrapalha(this.jx, this.jz, Math.hypot(this.jvx, this.jvz))) return false;
    for (const o of this.carros) {
      if (o !== c && atrapalha(o.x, o.z, o.v)) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------- visuais

const _matCache = new Map<number, THREE.MeshStandardMaterial>();
function matCor(cor: number, rough = 0.6, metal = 0): THREE.MeshStandardMaterial {
  const chave = cor * 1000 + Math.round(rough * 100) * 10 + metal;
  let m = _matCache.get(chave);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: cor, roughness: rough, metalness: metal });
    _matCache.set(chave, m);
  }
  return m;
}

/** Perfil lateral (z para frente, y para cima) extrudado na largura. */
function extrudarPerfil(pts: [number, number][], largura: number, bisel: number): THREE.BufferGeometry {
  const forma = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const geo = new THREE.ExtrudeGeometry(forma, {
    depth: largura - 2 * bisel,
    bevelEnabled: true,
    bevelThickness: bisel,
    bevelSize: bisel,
    bevelSegments: 2,
    curveSegments: 4,
  });
  // forma: x → z do mundo; extrusão (+z) → −x do mundo
  geo.rotateY(-Math.PI / 2);
  geo.translate((largura - 2 * bisel) / 2, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

let _geoCarro: {
  carroceria: THREE.BufferGeometry;
  vidros: THREE.BufferGeometry;
  teto: THREE.BufferGeometry;
  pneu: THREE.BufferGeometry;
  calota: THREE.BufferGeometry;
  farol: THREE.BufferGeometry;
  lanterna: THREE.BufferGeometry;
  seta: THREE.BufferGeometry;
  placa: THREE.BufferGeometry;
  grade: THREE.BufferGeometry;
  retrovisor: THREE.BufferGeometry;
  parachoque: THREE.BufferGeometry;
} | null = null;

function geometriasCarro() {
  if (_geoCarro) return _geoCarro;
  const carroceria = extrudarPerfil(
    [
      [-1.9, 0.26], [1.86, 0.26], [1.95, 0.42], [1.93, 0.66], [1.25, 0.82],
      [0.55, 0.9], [-1.55, 0.94], [-1.9, 0.9], [-1.95, 0.6],
    ],
    1.66, 0.06,
  );
  const vidros = extrudarPerfil(
    [[0.6, 0.88], [-0.05, 1.33], [-1.25, 1.35], [-1.72, 0.92]],
    1.46, 0.04,
  );
  const teto = new THREE.BoxGeometry(1.38, 0.05, 1.2);
  teto.translate(0, 1.38, -0.65);
  const pneu = new THREE.CylinderGeometry(0.29, 0.29, 0.19, 16);
  pneu.rotateZ(Math.PI / 2);
  const calota = new THREE.CylinderGeometry(0.17, 0.17, 0.2, 12);
  calota.rotateZ(Math.PI / 2);
  // marcas na calota para ver o giro
  const farol = new THREE.BoxGeometry(0.34, 0.12, 0.06);
  const lanterna = new THREE.BoxGeometry(0.3, 0.14, 0.05);
  const seta = new THREE.BoxGeometry(0.1, 0.07, 0.05);
  const placa = new THREE.BoxGeometry(0.4, 0.13, 0.02);
  const grade_ = new THREE.BoxGeometry(0.9, 0.12, 0.04);
  const retrovisor = new THREE.BoxGeometry(0.16, 0.1, 0.1);
  const parachoque = new THREE.BoxGeometry(1.62, 0.16, 0.12);
  _geoCarro = { carroceria, vidros, teto, pneu, calota, farol, lanterna, seta, placa, grade: grade_, retrovisor, parachoque };
  return _geoCarro;
}

function criarVisualCarro(cor: number): VisualCarro {
  const g = geometriasCarro();
  const raiz = new THREE.Group();
  raiz.name = 'carro_trafego';
  const pintura = matCor(cor, 0.35, 0.3);
  const preto = matCor(0x151515, 0.8);
  const plastico = matCor(0x262626, 0.7);
  const vidro = new THREE.MeshStandardMaterial({ color: 0x1b2633, roughness: 0.08, metalness: 0.5 });
  const borracha = matCor(0x111111, 0.95);
  const aro = matCor(0xb5b8bc, 0.35, 1);

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, sombra = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = sombra;
    m.receiveShadow = true;
    raiz.add(m);
    return m;
  };
  add(g.carroceria, pintura);
  add(g.vidros, vidro);
  add(g.teto, pintura);
  add(g.parachoque, plastico, 0, 0.33, 1.93);
  add(g.parachoque, plastico, 0, 0.35, -1.93);
  add(g.grade, preto, 0, 0.55, 1.95, false);

  const farol = new THREE.MeshStandardMaterial({ color: 0xfff6dd, emissive: 0xfff3cc, emissiveIntensity: 0.6, roughness: 0.2 });
  add(g.farol, farol, 0.55, 0.62, 1.93, false);
  add(g.farol, farol, -0.55, 0.62, 1.93, false);
  const freio = new THREE.MeshStandardMaterial({ color: 0x8a0d0d, emissive: 0xff1a10, emissiveIntensity: 0.35, roughness: 0.3 });
  add(g.lanterna, freio, 0.6, 0.74, -1.93, false);
  add(g.lanterna, freio, -0.6, 0.74, -1.93, false);
  const setaDir = new THREE.MeshStandardMaterial({ color: 0x8a5a00, emissive: 0xff9a00, emissiveIntensity: 0, roughness: 0.3 });
  const setaEsq = setaDir.clone();
  // direita do carro = −X local (frente +Z, cima +Y)
  add(g.seta, setaDir, -0.72, 0.58, 1.92, false);
  add(g.seta, setaDir, -0.8, 0.74, -1.92, false);
  add(g.seta, setaEsq, 0.72, 0.58, 1.92, false);
  add(g.seta, setaEsq, 0.8, 0.74, -1.92, false);
  add(g.placa, matCor(0xf4f4f4, 0.5), 0, 0.5, -1.99, false);
  add(g.retrovisor, pintura, 0.86, 1.0, 0.45);
  add(g.retrovisor, pintura, -0.86, 1.0, 0.45);

  const rodas: THREE.Object3D[] = [];
  for (const [x, z] of [[0.72, 1.2], [-0.72, 1.2], [0.72, -1.25], [-0.72, -1.25]]) {
    const roda = new THREE.Group();
    roda.position.set(x, 0.29, z);
    const pneu = new THREE.Mesh(g.pneu, borracha);
    pneu.castShadow = true;
    const cal = new THREE.Mesh(g.calota, aro);
    // um raio mais escuro para ver a roda girando
    const raio = new THREE.Mesh(new THREE.BoxGeometry(0.205, 0.04, 0.3), plastico);
    roda.add(pneu, cal, raio);
    raiz.add(roda);
    rodas.push(roda);
  }
  return { raiz, rodas, freio, setaDir, setaEsq };
}

function criarVisualPedestre(sorteio: () => number): VisualPed {
  const escolher = (a: number[]) => a[Math.floor(sorteio() * a.length)];
  const pele = matCor(escolher(PELES), 0.8);
  const roupa = matCor(escolher(ROUPAS), 0.85);
  const calca = matCor(escolher(CALCAS), 0.85);
  const cabelo = matCor(escolher(CABELOS), 0.9);
  const sapato = matCor(0x1d1d1d, 0.7);
  const escala = 0.92 + sorteio() * 0.14;

  const raiz = new THREE.Group();
  raiz.name = 'pedestre';
  const corpo = new THREE.Group();
  corpo.scale.setScalar(escala);
  raiz.add(corpo);
  const malha = (geo: THREE.BufferGeometry, mat: THREE.Material, pai: THREE.Object3D, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    pai.add(m);
    return m;
  };
  const perna = (x: number) => {
    const piv = new THREE.Group();
    piv.position.set(x, 0.9, 0);
    malha(new THREE.CapsuleGeometry(0.075, 0.68, 3, 8), calca, piv, 0, -0.43, 0);
    malha(new THREE.BoxGeometry(0.11, 0.07, 0.24), sapato, piv, 0, -0.865, 0.04);
    corpo.add(piv);
    return piv;
  };
  const braco = (x: number) => {
    const piv = new THREE.Group();
    piv.position.set(x, 1.4, 0);
    malha(new THREE.CapsuleGeometry(0.055, 0.42, 3, 8), roupa, piv, 0, -0.24, 0);
    malha(new THREE.SphereGeometry(0.05, 8, 6), pele, piv, 0, -0.55, 0);
    corpo.add(piv);
    return piv;
  };
  const pernaE = perna(0.1);
  const pernaD = perna(-0.1);
  const tronco = malha(new THREE.CapsuleGeometry(0.17, 0.36, 4, 10), roupa, corpo, 0, 1.2, 0);
  tronco.scale.set(1, 1, 0.62);
  const quadril = malha(new THREE.BoxGeometry(0.32, 0.16, 0.2), calca, corpo, 0, 0.94, 0);
  quadril.castShadow = true;
  malha(new THREE.CylinderGeometry(0.045, 0.05, 0.08, 8), pele, corpo, 0, 1.5, 0);
  malha(new THREE.SphereGeometry(0.11, 12, 10), pele, corpo, 0, 1.62, 0);
  const cab = malha(new THREE.SphereGeometry(0.117, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), cabelo, corpo, 0, 1.635, -0.01);
  cab.rotation.x = -0.25;
  const bracoE = braco(0.23);
  const bracoD = braco(-0.23);
  return { raiz, pernaE, pernaD, bracoE, bracoD, corpo };
}
