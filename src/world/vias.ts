import * as THREE from 'three';
import dados from './autoescola/vias.json';
import { px } from './autoescola';

/**
 * Faixas de rolamento da pista da autoescola (gerado por `node scripts/gerar-vias.mjs`).
 * Cada faixa é uma linha central em coordenadas de mundo (y = 0), com os pontos
 * na ORDEM DO SENTIDO DO TRÂNSITO.
 *
 *  - anel_interno: mão dupla com o externo, sentido horário visto de cima
 *    (na planta: sobe pela esquerda — onde fica a baliza, à direita de quem sobe).
 *  - anel_externo: sentido anti-horário.
 *  - diagonal_1..3: avenida de mão única, 3 faixas, sentido “subindo” (para −Z).
 */
export interface Faixa {
  id: string;
  fechada: boolean;
  mao: 'dupla' | 'unica';
  pontos: THREE.Vector3[];
  /** Distância acumulada até cada ponto (m). */
  acumulado: number[];
  comprimento: number;
  /** Meia largura aproximada da faixa (m). */
  meiaLargura: number;
}

export interface ProjecaoFaixa {
  faixa: Faixa;
  /** Posição ao longo da faixa (m, 0..comprimento). */
  s: number;
  ponto: THREE.Vector3;
  /** Direção do trânsito nesse ponto (unitária, no plano XZ). */
  direcao: THREE.Vector3;
  /** Distância lateral até a linha central (m, sempre ≥ 0). */
  distancia: number;
  /** Lado: + = à esquerda da direção do trânsito, − = à direita. */
  lado: number;
}

function montar(): Faixa[] {
  return (dados.faixas as { id: string; fechada: boolean; mao: 'dupla' | 'unica'; pontos: number[][] }[]).map((f) => {
    const pontos = f.pontos.map(([x, y]) => px(x, y));
    const acumulado = [0];
    const n = pontos.length;
    const segs = f.fechada ? n : n - 1;
    for (let i = 0; i < segs; i++) acumulado.push(acumulado[i] + pontos[i].distanceTo(pontos[(i + 1) % n]));
    return {
      id: f.id,
      fechada: f.fechada,
      mao: f.mao,
      pontos,
      acumulado,
      comprimento: acumulado[acumulado.length - 1],
      meiaLargura: f.id.startsWith('diagonal') ? 1.75 : 1.8,
    };
  });
}

export const FAIXAS: Faixa[] = montar();

export function faixaPorId(id: string): Faixa {
  const f = FAIXAS.find((x) => x.id === id);
  if (!f) throw new Error(`faixa desconhecida: ${id}`);
  return f;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Projeta um ponto numa faixa (segmento mais próximo). */
export function projetar(f: Faixa, p: THREE.Vector3): ProjecaoFaixa {
  const n = f.pontos.length;
  const segs = f.fechada ? n : n - 1;
  let melhor = { d2: Infinity, i: 0, t: 0 };
  for (let i = 0; i < segs; i++) {
    _a.copy(f.pontos[i]);
    _b.copy(f.pontos[(i + 1) % n]);
    const abx = _b.x - _a.x, abz = _b.z - _a.z;
    const len2 = abx * abx + abz * abz || 1e-9;
    let t = ((p.x - _a.x) * abx + (p.z - _a.z) * abz) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = _a.x + abx * t, qz = _a.z + abz * t;
    const d2 = (p.x - qx) ** 2 + (p.z - qz) ** 2;
    if (d2 < melhor.d2) melhor = { d2, i, t };
  }
  const a = f.pontos[melhor.i];
  const b = f.pontos[(melhor.i + 1) % n];
  const direcao = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
  const ponto = new THREE.Vector3().lerpVectors(a, b, melhor.t);
  const rel = _p.set(p.x - ponto.x, 0, p.z - ponto.z);
  // esquerda de quem anda na direção d: cima × d = (d.z, 0, −d.x)
  const esquerda = new THREE.Vector3(direcao.z, 0, -direcao.x);
  return {
    faixa: f,
    s: f.acumulado[melhor.i] + a.distanceTo(b) * melhor.t,
    ponto,
    direcao,
    distancia: Math.sqrt(melhor.d2),
    lado: Math.sign(rel.dot(esquerda)) || 0,
  };
}

/** Faixa mais próxima do ponto (e a projeção nela). */
export function faixaMaisProxima(p: THREE.Vector3, faixas: Faixa[] = FAIXAS): ProjecaoFaixa {
  let melhor: ProjecaoFaixa | null = null;
  for (const f of faixas) {
    const pr = projetar(f, p);
    if (!melhor || pr.distancia < melhor.distancia) melhor = pr;
  }
  return melhor!;
}

/** Ponto e direção a `s` metros do início da faixa (faixas fechadas dão a volta). */
export function amostrar(f: Faixa, s: number): { ponto: THREE.Vector3; direcao: THREE.Vector3 } {
  const n = f.pontos.length;
  if (f.fechada) s = ((s % f.comprimento) + f.comprimento) % f.comprimento;
  else s = Math.max(0, Math.min(f.comprimento, s));
  // busca binária no acumulado
  let lo = 0, hi = f.acumulado.length - 1;
  while (lo < hi - 1) {
    const m = (lo + hi) >> 1;
    if (f.acumulado[m] <= s) lo = m;
    else hi = m;
  }
  const i = Math.min(lo, (f.fechada ? n : n - 1) - 1);
  const a = f.pontos[i];
  const b = f.pontos[(i + 1) % n];
  const seg = f.acumulado[i + 1] - f.acumulado[i] || 1e-9;
  const t = Math.max(0, Math.min(1, (s - f.acumulado[i]) / seg));
  return {
    ponto: new THREE.Vector3().lerpVectors(a, b, t),
    direcao: new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize(),
  };
}
