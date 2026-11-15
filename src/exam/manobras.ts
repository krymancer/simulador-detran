import * as THREE from 'three';
import { lerGrade, METROS_POR_PX, px } from '../world/autoescola';

/**
 * Geometria das manobras do examinador na pista da autoescola, tirada da planta
 * (sem mexer em autoescola.ts): vagas a 90° "PARE", área do estacionamento para a
 * meia-volta, trecho de parada junto ao meio-fio, e a leitura da grade de calçadas
 * para medir a distância até o meio-fio.
 */

/** Retângulo alinhado aos eixos, em px da planta. */
export interface RetPlanta {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Vagas a 90° pintadas "PARE" em cima à direita (asfalto entre meios-fios, lido da grade):
 * abrem para o norte, para a faixa interna do anel (sentido leste).
 *  - vaga 1: 3,65 m × 4,35 m
 *  - vaga 2: 3,65 m × 6,8 m
 */
export const VAGAS_90: RetPlanta[] = [
  { x0: 940, x1: 1024, y0: 180, y1: 280 },
  { x0: 1080, x1: 1164, y0: 180, y1: 336 },
];

/** Asfalto do estacionamento de baixo (onde o carro nasce): meia-volta e estacionamento final. */
export const ESTACIONAMENTO: RetPlanta = { x0: 920, x1: 1548, y0: 1336, y1: 1500 };

/** Trecho reto da faixa externa do lado esquerdo (sentido sul) com meio-fio contínuo em x ≈ 80 px. */
export const TRECHO_MEIO_FIO = { x: 121, yIni: 820, yFim: 980, yAlvo: 900 };

/** Mundo → planta (px). */
export function paraPlanta(p: THREE.Vector3): { x: number; y: number } {
  const o = px(0, 0);
  return { x: (p.x - o.x) / METROS_POR_PX, y: (p.z - o.z) / METROS_POR_PX };
}

export function dentroRet(r: RetPlanta, p: THREE.Vector3, folgaM = 0): boolean {
  const q = paraPlanta(p);
  const f = folgaM / METROS_POR_PX;
  return q.x >= r.x0 - f && q.x <= r.x1 + f && q.y >= r.y0 - f && q.y <= r.y1 + f;
}

export function centroRet(r: RetPlanta): THREE.Vector3 {
  return px((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2);
}

let grade: boolean[][] | null = null;
let celulaPx = 4;

/** Há calçada/canteiro (elevado) no ponto do mundo? */
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

/**
 * Distância (m) de `de` até a primeira calçada andando na direção `dir` (no plano),
 * até `max`. Devolve 0 se o ponto já está sobre a calçada e Infinity se não achar.
 */
export function distanciaCalcada(de: THREE.Vector3, dir: THREE.Vector3, max = 4): number {
  const d = new THREE.Vector3(dir.x, 0, dir.z).normalize();
  const p = new THREE.Vector3();
  for (let s = 0; s <= max; s += 0.02) {
    p.set(de.x + d.x * s, 0, de.z + d.z * s);
    if (calcadaEm(p)) return s;
  }
  return Infinity;
}
