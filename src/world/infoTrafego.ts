import type * as THREE from 'three';

/**
 * O que o trânsito (src/world/trafego.ts) informa para a prova (src/exam/*) a cada passo.
 * Fica num arquivo próprio para os dois lados não dependerem um do outro.
 */
export interface InfoTrafego {
  /** Pedestres e, se estiverem numa faixa de pedestres, o nome da zona (ex.: "FAIXA_PEDESTRE_1"). */
  pedestres: { posicao: THREE.Vector3; naFaixa: string | null }[];
  /** Carros do trânsito (posição e velocidade), para o examinador avaliar distância/preferência. */
  carros: { posicao: THREE.Vector3; velocidade: number }[];
  /** Acontecimentos desde a última leitura (o consumidor esvazia). */
  eventos: ('colisao_carro' | 'atropelou_pedestre')[];
}

export const INFO_TRAFEGO_VAZIA: InfoTrafego = { pedestres: [], carros: [], eventos: [] };
