import type { AcaoBotao } from '../../input/input';
import type { Exec } from '../passo';

/** Textos e condições usados por várias lições. */

const POS_H: Record<number, string> = {
  1: 'para a esquerda e para a frente',
  2: 'para a esquerda e para trás',
  3: 'para o meio e para a frente',
  4: 'para o meio e para trás',
  5: 'para a direita e para a frente',
  [-1]: 'para baixo, depois para a direita e para trás',
};

export const nomeMarcha = (m: number) => (m === -1 ? 'ré' : m === 0 ? 'neutro' : `${m}ª`);

/** Como engatar a marcha `m` no dispositivo atual. */
export function comoEngatar(x: Exec, m: number): string {
  if (m === 0) return comoNeutro(x);
  if (x.dispositivo === 'controle') {
    return m === -1
      ? `aperte ${x.nome('marchaMenos')} até passar do neutro para a ré`
      : `use ${x.nome('marchaMais')} para subir e ${x.nome('marchaMenos')} para descer até a ${m}ª`;
  }
  if (x.dispositivo === 'toque') return `toque no ${m === -1 ? 'R' : m} do câmbio da tela (à direita)`;
  const acao = (m === -1 ? 'marchaR' : `marcha${m}`) as AcaoBotao;
  if (x.dispositivo === 'volante') return `leve a alavanca ${POS_H[m]} (${x.nome(acao)})`;
  return `aperte ${x.nome(acao)}`;
}

export function comoNeutro(x: Exec): string {
  if (x.dispositivo === 'controle') return `use ${x.nome('marchaMenos')}/${x.nome('marchaMais')} até o N (neutro)`;
  if (x.dispositivo === 'volante') return 'deixe a alavanca solta no meio, sem marcha nenhuma';
  if (x.dispositivo === 'toque') return 'toque no N do câmbio da tela';
  return 'aperte a tecla N (ou 0)';
}

/** Marcha engatada de verdade no câmbio (não só pedida). */
export const engatada = (x: Exec, m: number) => x.trem.marchaEngatada === m && x.ent.marcha === m;

export const parado = (x: Exec, lim = 0.08) => Math.abs(x.sim.carro.velocidadeLongitudinal()) < lim;

/** O carro assentou depois do teleporte. */
export const assentado = (x: Exec) => x.t > 1.2 && x.sim.carro.velocidade() < 0.08;

export function partidaTexto(x: Exec): string {
  return `Pise a embreagem até o fundo (${x.nome('embreagem')}), confira se está em neutro e segure ${x.nome('partida')} até o motor pegar.`;
}

export const TORQUE_PONTO = 6; // N·m passando pela embreagem: o carro "sente" a marcha
