import * as THREE from 'three';
import type { Simulacao } from '../sim/simulation';
import { lerGrade, METROS_POR_PX, px } from '../world/autoescola';
import { amostrar, faixaPorId, projetar } from '../world/vias';
import type { Obstaculo, Zona } from '../world/parser';

/** Geometria usada pelas lições (sem DOM). Planta: x → leste, y → sul (px). */

/** Mundo → planta (px). */
export function paraPlanta(p: THREE.Vector3): { x: number; y: number } {
  const o = px(0, 0);
  return { x: (p.x - o.x) / METROS_POR_PX, y: (p.z - o.z) / METROS_POR_PX };
}

/** yaw do carro (frente = (sen yaw, 0, cos yaw)) apontando na direção (dx, dy) da planta. */
export function yawPlanta(dx: number, dy: number): number {
  return Math.atan2(dx, dy);
}

/** yaw de uma direção no mundo (plano XZ). */
export function yawMundo(d: THREE.Vector3): number {
  return Math.atan2(d.x, d.z);
}

export interface PosePlanta {
  x: number;
  y: number;
  yaw: number;
}

/**
 * Ponto na linha central de uma faixa de vias.ts, perto do ponto (x, y) da planta,
 * recuado `recuoM` metros contra o sentido do trânsito. Devolve px + yaw no sentido da faixa.
 */
export function naFaixa(id: string, x: number, y: number, recuoM = 0): PosePlanta {
  const f = faixaPorId(id);
  const pr = projetar(f, px(x, y));
  const a = amostrar(f, pr.s - recuoM);
  const p = paraPlanta(a.ponto);
  return { x: p.x, y: p.y, yaw: yawMundo(a.direcao) };
}

const _q = new THREE.Quaternion();

export interface PoseCarro {
  pos: THREE.Vector3;
  frente: THREE.Vector3;
  /** à esquerda do carro (+X local) */
  esquerda: THREE.Vector3;
  yaw: number;
  /** velocidade longitudinal (m/s, negativa = de ré) */
  v: number;
  /** [esq. frente, dir. frente, esq. trás, dir. trás] (mundo, perto do chão) */
  cantos: THREE.Vector3[];
  paraChoque: THREE.Vector3;
  traseira: THREE.Vector3;
}

export function poseCarro(sim: Simulacao): PoseCarro {
  const carro = sim.carro;
  const t = carro.corpo.translation();
  const r = carro.corpo.rotation();
  _q.set(r.x, r.y, r.z, r.w);
  const pos = new THREE.Vector3(t.x, t.y, t.z);
  const frente = new THREE.Vector3(0, 0, 1).applyQuaternion(_q);
  const esquerda = new THREE.Vector3(1, 0, 0).applyQuaternion(_q);
  const cb = carro.cfg.carroceria;
  const yBaixo = -carro.cfg.alturaCG + 0.2;
  const zF = cb.centro[2] + cb.meiaComprimento;
  const zT = cb.centro[2] - cb.meiaComprimento;
  const w = cb.meiaLargura;
  const q = _q.clone();
  const canto = (x: number, z: number) => new THREE.Vector3(x, yBaixo, z).applyQuaternion(q).add(pos);
  return {
    pos,
    frente,
    esquerda,
    yaw: Math.atan2(frente.x, frente.z),
    v: carro.velocidadeLongitudinal(),
    cantos: [canto(w, zF), canto(-w, zF), canto(w, zT), canto(-w, zT)],
    paraChoque: canto(0, zF),
    traseira: canto(0, zT),
  };
}

let grade: boolean[][] | null = null;
let celulaPx = 4;

/** Há calçada/canteiro (elevado) no ponto do mundo? Fora da planta = sim (grama). */
export function calcadaEm(p: THREE.Vector3): boolean {
  if (!grade) {
    grade = lerGrade();
    const alturaPx = (-2 * px(0, 0).z) / METROS_POR_PX;
    celulaPx = alturaPx / grade.length;
  }
  const q = paraPlanta(p);
  const gy = Math.floor(q.y / celulaPx);
  const gx = Math.floor(q.x / celulaPx);
  if (gy < 0 || gy >= grade.length || gx < 0 || gx >= grade[0].length) return true;
  return grade[gy][gx];
}

/** Referencial de uma zona-caixa do mapa: centro, eixo comprido (+Z local) e transversal (+X local), em mundo. */
export interface QuadroZona {
  zona: Zona;
  centro: THREE.Vector3;
  eixoZ: THREE.Vector3;
  eixoX: THREE.Vector3;
  meioComprimento: number;
  meiaLargura: number;
  /** mundo → local (só no plano: x ao longo de eixoX, z ao longo de eixoZ) */
  local: (p: THREE.Vector3) => { x: number; z: number };
  mundo: (x: number, z: number) => THREE.Vector3;
}

export function quadroZona(z: Zona): QuadroZona {
  const m = new THREE.Matrix4().copy(z.inversa).invert();
  const o = new THREE.Vector3().setFromMatrixPosition(m);
  const ex = new THREE.Vector3(1, 0, 0).transformDirection(m).setY(0).normalize();
  const ez = new THREE.Vector3(0, 0, 1).transformDirection(m).setY(0).normalize();
  const cxl = (z.min.x + z.max.x) / 2;
  const czl = (z.min.z + z.max.z) / 2;
  const centro = o.clone().addScaledVector(ex, cxl).addScaledVector(ez, czl).setY(0);
  return {
    zona: z,
    centro,
    eixoX: ex,
    eixoZ: ez,
    meioComprimento: (z.max.z - z.min.z) / 2,
    meiaLargura: (z.max.x - z.min.x) / 2,
    local: (p) => {
      const dx = p.x - centro.x;
      const dz = p.z - centro.z;
      return { x: dx * ex.x + dz * ex.z, z: dx * ez.x + dz * ez.z };
    },
    mundo: (x, zz) => centro.clone().addScaledVector(ex, x).addScaledVector(ez, zz),
  };
}

/** Uma haste/cone (círculo no plano) toca a carroceria? (mesma conta da Prova) */
export function tocaObstaculo(sim: Simulacao, o: Obstaculo): boolean {
  const corpo = sim.carro.corpo;
  const cb = sim.carro.cfg.carroceria;
  const t = corpo.translation();
  const r = corpo.rotation();
  _q.set(r.x, r.y, r.z, r.w).invert();
  const p = new THREE.Vector3(o.x - t.x, 0, o.z - t.z).applyQuaternion(_q);
  const cx = Math.max(-cb.meiaLargura, Math.min(cb.meiaLargura, p.x));
  const cz = Math.max(cb.centro[2] - cb.meiaComprimento, Math.min(cb.centro[2] + cb.meiaComprimento, p.z));
  return Math.hypot(p.x - cx, p.z - cz) < o.raio;
}

/** Diferença de ângulos em (−π, π]. */
export function difAngulo(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}
