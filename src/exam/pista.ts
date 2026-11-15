import * as THREE from 'three';
import type { Mapa } from '../world/parser';
import { Faixa, FAIXAS, ProjecaoFaixa, projetar } from '../world/vias';
import { px } from '../world/autoescola';
import divisoriaJson from '../world/autoescola/divisoria.json';

/** Uma amostra da linha amarela contínua do anel (mundo): centro da tinta e normal para o anel interno. */
interface AmostraLinha { x: number; z: number; nx: number; nz: number }

/**
 * Leitura das faixas (vias.ts) para a prova: em que faixa o carro está, se ela é
 * confiável naquele ponto, e onde ficam os cruzamentos (onde a linha amarela é
 * interrompida e trocar de faixa/atravessar o anel é permitido).
 *
 * Só funciona no mapa da autoescola (as faixas são dele). Em outros mapas, `ativa` = false.
 */
export interface Cruzamento {
  centro: THREE.Vector3;
  raio: number;
}

export interface LeituraFaixa {
  proj: ProjecaoFaixa;
  /** Faixa confiável aqui (fora de cruzamento e com geometria coerente). */
  confiavel: boolean;
}

/** Distância entre o anel interno e o externo considerada coerente (m). */
const SEP_MIN = 2.8;
const SEP_MAX = 4.6;

export class Pista {
  readonly ativa: boolean;
  readonly faixas: Faixa[];
  readonly interno: Faixa | null;
  readonly externo: Faixa | null;
  readonly cruzamentos: Cruzamento[] = [];
  /** Linha amarela contínua medida na planta (vazia fora da autoescola). */
  private readonly linha: AmostraLinha[] = [];

  constructor(mapa: Mapa, faixas?: Faixa[]) {
    const usar = faixas ?? (ehAutoescola(mapa) ? FAIXAS : []);
    this.faixas = usar;
    this.ativa = usar.length > 0;
    this.interno = usar.find((f) => f.id === 'anel_interno') ?? null;
    this.externo = usar.find((f) => f.id === 'anel_externo') ?? null;
    if (!this.ativa) return;
    if (!faixas) {
      for (const a of divisoriaJson.pontos as { p: number[]; n: number[] }[]) {
        const w = px(a.p[0], a.p[1]);
        this.linha.push({ x: w.x, z: w.z, nx: a.n[0], nz: a.n[1] });
      }
    }

    // Cruzamentos: pontas da avenida (entrada embaixo, saída em cima com as faixas de
    // pedestres) e a saída do estacionamento (projeção do spawn no anel).
    const diagonais = usar.filter((f) => f.id.startsWith('diagonal'));
    if (diagonais.length) {
      const ini = media(diagonais.map((f) => f.pontos[0]));
      this.cruzamentos.push({ centro: ini, raio: 12 });
    }
    const faixasPed = mapa.zonas.filter((z) => z.tipo === 'faixa_pedestre').map((z) => z.centro);
    if (faixasPed.length) {
      // Em cima: área aberta entre as faixas de pedestres, onde a avenida desemboca.
      const c = media(faixasPed).setY(0);
      // Folga grande: as linhas centrais de vias.json em cima à direita não batem com a planta (ver relatório).
      const r = Math.max(...faixasPed.map((p) => Math.hypot(p.x - c.x, p.z - c.z))) + 16;
      this.cruzamentos.push({ centro: c, raio: r });
    } else if (diagonais.length) {
      this.cruzamentos.push({ centro: media(diagonais.map((f) => f.pontos[f.pontos.length - 1])), raio: 14 });
    }
    if (this.externo) {
      const p = projetar(this.externo, mapa.spawn.posicao).ponto;
      this.cruzamentos.push({ centro: p, raio: 9 });
    }
  }

  noCruzamento(p: THREE.Vector3): boolean {
    return this.cruzamentos.some((c) => Math.hypot(p.x - c.centro.x, p.z - c.centro.z) < c.raio);
  }

  /** Geometria do anel coerente perto de p (as duas faixas paralelas, de sentidos opostos). */
  anelCoerente(p: THREE.Vector3): boolean {
    if (!this.interno || !this.externo) return false;
    const a = projetar(this.interno, p);
    const b = projetar(this.externo, p);
    const sep = Math.hypot(a.ponto.x - b.ponto.x, a.ponto.z - b.ponto.z);
    return sep > SEP_MIN && sep < SEP_MAX && a.direcao.dot(b.direcao) < -0.8;
  }

  /**
   * Quanto o ponto p passou da linha amarela contínua para o lado oposto ao do
   * anel `doLado` (m; negativo = ainda do lado certo). null onde não há linha
   * contínua (tracejado, cruzamentos) ou fora da autoescola.
   */
  alemDaLinha(p: THREE.Vector3, doLado: 'interno' | 'externo'): number | null {
    let melhor: AmostraLinha | null = null;
    let bd = Infinity;
    for (const a of this.linha) {
      const d = (p.x - a.x) ** 2 + (p.z - a.z) ** 2;
      if (d < bd) { bd = d; melhor = a; }
    }
    if (!melhor || bd > 3 * 3) return null;
    const dx = p.x - melhor.x, dz = p.z - melhor.z;
    const normal = dx * melhor.nx + dz * melhor.nz; // + = lado do anel interno
    const tangencial = Math.abs(dx * -melhor.nz + dz * melhor.nx);
    if (tangencial > 0.6) return null; // na ponta de um trecho: depois dele não há linha
    return doLado === 'interno' ? -normal : normal;
  }

  /** Faixa mais próxima de p (só se p estiver dentro dela, com folga). */
  faixaEm(p: THREE.Vector3, folga = 0.6): LeituraFaixa | null {
    let melhor: ProjecaoFaixa | null = null;
    for (const f of this.faixas) {
      const pr = projetar(f, p);
      if (!melhor || pr.distancia < melhor.distancia) melhor = pr;
    }
    if (!melhor || melhor.distancia > melhor.faixa.meiaLargura + folga) return null;
    const anel = melhor.faixa === this.interno || melhor.faixa === this.externo;
    const confiavel = !this.noCruzamento(p) && (!anel || this.anelCoerente(p));
    return { proj: melhor, confiavel };
  }
}

export function ehAutoescola(mapa: Mapa): boolean {
  return mapa.raiz.name === 'autoescola' || mapa.raiz.getObjectByName('autoescola') !== undefined;
}

function media(ps: THREE.Vector3[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  for (const p of ps) c.add(p);
  return c.multiplyScalar(1 / Math.max(1, ps.length)).setY(0);
}

/** Diferença s − alvo numa faixa (fechada: no intervalo (−L/2, L/2]). */
export function deltaS(f: Faixa, s: number, alvo: number): number {
  let d = s - alvo;
  if (f.fechada) {
    const L = f.comprimento;
    d = ((d % L) + L) % L;
    if (d > L / 2) d -= L;
  }
  return d;
}
