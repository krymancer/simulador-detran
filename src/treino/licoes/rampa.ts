import * as THREE from 'three';
import { naFaixa } from '../geo';
import { clamp01, DefLicao, Exec, leitura, Passo, segurar } from '../passo';
import { comoEngatar, engatada } from './comum';

/**
 * Lição 4 — Saída em rampa. O carro é colocado parado no meio da subida da reta da
 * direita (ZONA_RAMPA_1, faixa externa, sentido norte). Três saídas com o freio de
 * mão e uma com o "freio de pé". Recuar mais de 30 cm ou deixar o motor morrer = refazer.
 */

/**
 * Ponto de parada na subida (px + yaw): no começo da subida, com ~10% de inclinação
 * (onde se costuma parar na prova). O meio da rampa chega a ~15%, pesado demais
 * para a primeira saída de um 1.0.
 */
export const INICIO_RAMPA = naFaixa('anel_externo', 1481, 930, 0);

export const RECUO_MAX = 0.3; // m
export const DISTANCIA_SAIDA = 3; // m andados para frente = saiu
/** Mínimo de torque na embreagem para contar como "ponto" (N·m), mesmo em subida suave. */
export const TORQUE_PONTO_RAMPA = 8;

/**
 * Torque na embreagem (N·m) que segura o carro sozinho nesta subida, em 1ª:
 * m·g·sen(θ)·r / (relação·diferencial·eficiência).
 */
function torqueSegura(x: Exec): number {
  const c = x.sim.carro.cfg;
  const sen = Math.max(0, x.pose().frente.y);
  const g = c.cambio.relacoes[0] * c.cambio.diferencial * c.cambio.eficiencia;
  return (c.massa * 9.81 * sen * c.roda.raio) / g;
}
/** Ponto na rampa: o carro já "puxa" ~80% do que precisa para não voltar (o freio ajuda no resto). */
const alvoPonto = (x: Exec) => Math.max(TORQUE_PONTO_RAMPA, 0.8 * torqueSegura(x));
/** Medidor: 1 = 1,5× o necessário para segurar o carro. Faixa verde a partir do alvo. */
const FAIXA_RAMPA: [number, number] = [0.8 / 1.5, 0.95];

/** Quanto o carro andou para frente desde a âncora (m; negativo = recuou). */
function avanco(x: Exec): number {
  const a = x.licao.ancora as { pos: THREE.Vector3; frente: THREE.Vector3 } | undefined;
  if (!a) return 0;
  return x.pose().pos.clone().sub(a.pos).dot(a.frente);
}

/** Registra o recuo máximo (cm) e diz se passou do limite. */
function recuou(x: Exec): string | null {
  const r = -avanco(x);
  x.licao.recuoMax = Math.max(x.licao.recuoMax ?? 0, r);
  if (r > RECUO_MAX) {
    return `O carro voltou ${Math.round(r * 100)} centímetros. Na prova, recuar mais de 30 cm na rampa é falta. Vamos de novo: o segredo é o carro já estar "puxando" no ponto da embreagem antes de soltar o freio.`;
  }
  return null;
}

function apagouOuRecuou(x: Exec): string | null {
  const r = recuou(x);
  if (r) return r;
  if (x.licao.motorLigadoNaTentativa && !x.trem.ligado && !x.ent.partidaBorda) {
    return 'O motor morreu na subida. Na rampa o carro precisa de um pouco mais de acelerador: deixe o giro perto de 1500 antes de soltar a embreagem, e solte devagar. Vamos de novo.';
  }
  if (x.trem.ligado) x.licao.motorLigadoNaTentativa = true;
  return null;
}

const pontoRampa = (x: Exec) => clamp01(Math.abs(x.trem.torqueEmbreagem) / (1.5 * Math.max(TORQUE_PONTO_RAMPA / 0.8, torqueSegura(x))));

function tentativa(pref: string, titulo: string, pe: boolean): Passo[] {
  const inicio = `${pref}_posicionar`;
  const comum = { falhou: apagouOuRecuou, seFalhar: inicio, repetirDe: inicio };
  return [
    {
      id: inicio,
      titulo: `${titulo}: parado na subida`,
      foco: 'frente',
      semFesta: true,
      repetirDe: inicio,
      texto: (x) =>
        pe
          ? `${titulo}. O carro está parado na subida. Desta vez, segure o carro só com o pé no freio (${x.nome('freio')}) e solte o freio de mão (${x.nome('freioDeMao')}).`
          : `${titulo}. O carro está parado no meio da subida, com o freio de mão puxado. Se não estiver, puxe (${x.nome('freioDeMao')}).`,
      aoIniciar: (x) => {
        x.teleportar(INICIO_RAMPA.x, INICIO_RAMPA.y, INICIO_RAMPA.yaw);
        x.licao.ancora = undefined;
        x.licao.recuoMax = 0;
        x.licao.motorLigadoNaTentativa = false;
      },
      detectar: (x) => {
        const ok = x.t > 1.2 && x.sim.carro.velocidade() < 0.05 && (pe ? !x.ent.freioDeMao && x.ent.freio > 0.3 : x.ent.freioDeMao);
        if (ok && segurar(x, 'ok', true, 0.4)) {
          const p = x.pose();
          x.licao.ancora = { pos: p.pos.clone(), frente: p.frente.clone().setY(0).normalize() };
          return true;
        }
        if (!ok) x.mem.ok = 0;
        return false;
      },
    },
    {
      id: `${pref}_ligar`,
      titulo: `${titulo}: partida`,
      foco: 'volante',
      ...comum,
      falhou: recuou,
      texto: (x) => `Embreagem no fundo, neutro, e dê a partida (${x.nome('partida')}).${pe ? ' Continue com o pé no freio.' : ''}`,
      detectar: (x) => x.trem.ligado,
    },
    {
      id: `${pref}_primeira`,
      titulo: `${titulo}: 1ª marcha`,
      foco: 'cambio',
      ...comum,
      texto: (x) => `Engate a primeira: ${comoEngatar(x, 1)}.`,
      detectar: (x) => engatada(x, 1) && x.ent.embreagem > 0.7,
    },
    pe
      ? {
          id: `${pref}_ponto`,
          titulo: `${titulo}: ponto com o pé no freio`,
          foco: 'painel',
          ...comum,
          texto: 'Com o pé direito ainda no freio, solte a embreagem até o ponto, um pouco mais do que no plano: o giro cai e o carro "puxa" para a frente. Segure aí.',
          dica: 'No ponto certo o motor fica mais pesado mas não treme. Se tremer muito, pise um pouco a embreagem.',
          detectar: (x) => engatada(x, 1) && x.ent.freio > 0.2 && Math.abs(x.trem.torqueEmbreagem) >= alvoPonto(x) && segurar(x, 'p', true, 0.5),
          progresso: pontoRampa,
          rotuloProgresso: 'Ponto da embreagem',
          faixaBoa: FAIXA_RAMPA,
        }
      : {
          id: `${pref}_ponto`,
          titulo: `${titulo}: ponto e um pouco de acelerador`,
          foco: 'painel',
          ...comum,
          texto: (x) => `Acelere um pouquinho (${x.nome('acelerador')}), com o giro perto de 1500, e solte a embreagem até o ponto. Na subida o ponto é um pouco mais "fundo": o carro precisa puxar mais. Segure aí, com o freio de mão ainda puxado.`,
          dica: 'Você vai sentir o carro "abaixar" a traseira e o giro cair um pouco: é o ponto. O medidor verde ajuda.',
          detectar: (x) => engatada(x, 1) && x.ent.acelerador > 0.05 && Math.abs(x.trem.torqueEmbreagem) >= alvoPonto(x) && segurar(x, 'p', true, 0.5),
          progresso: pontoRampa,
          rotuloProgresso: 'Ponto da embreagem',
          faixaBoa: FAIXA_RAMPA,
        },
    {
      id: `${pref}_sair`,
      titulo: `${titulo}: sair sem voltar`,
      foco: null,
      ...comum,
      texto: (x) =>
        pe
          ? `Agora, rápido e suave: tire o pé do freio, passe para o acelerador (${x.nome('acelerador')}) e solte a embreagem devagar.`
          : `Solte o freio de mão (${x.nome('freioDeMao')}) e, ao mesmo tempo, acelere mais um pouco e solte a embreagem devagar.`,
      dica: 'Se o carro começar a voltar, acelere mais e solte menos a embreagem — ou pise a embreagem e o freio e comece de novo.',
      detectar: (x) => avanco(x) > DISTANCIA_SAIDA && x.trem.ligado,
      progresso: (x) => clamp01(avanco(x) / DISTANCIA_SAIDA),
      rotuloProgresso: 'Subindo',
      festa: 'Muito bem! Saiu sem voltar.',
      aoIniciar: (x) => {
        x.licao.recuoMax = Math.max(0, -avanco(x));
      },
    },
  ];
}

export const LICAO_RAMPA: DefLicao = {
  id: 'rampa',
  titulo: 'Saída em rampa',
  descricao: 'Parar na subida e sair sem deixar o carro voltar nem o motor morrer: três vezes com o freio de mão e uma com o pé no freio.',
  passos: [
    leitura('intro', 'Saída em rampa',
      'Na subida, se você soltar o freio sem o carro estar puxando, ele volta para trás. A técnica: primeira marcha, um pouco de acelerador, embreagem no ponto até o carro puxar, e só então soltar o freio de mão. Na prova, voltar mais de 30 centímetros é falta. Vamos treinar três vezes.',
      'frente'),
    ...tentativa('r1', 'Tentativa 1 de 3', false),
    ...tentativa('r2', 'Tentativa 2 de 3', false),
    ...tentativa('r3', 'Tentativa 3 de 3', false),
    leitura('pe_intro', 'Saída com o freio de pé',
      'Agora uma variação: segurar o carro só com o pé no freio. Com o pé esquerdo você acha o ponto da embreagem enquanto o direito segura o freio. Quando o carro puxar, passe o pé direito do freio para o acelerador, rápido e suave.',
      'pedais'),
    ...tentativa('pe', 'Freio de pé', true),
  ],
  resumo: (x) => `Você fez a saída em rampa! O maior recuo da última saída foi de ${Math.round((x.licao.recuoMax ?? 0) * 100)} cm.`,
};
