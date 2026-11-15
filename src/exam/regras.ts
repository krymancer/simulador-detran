/**
 * Tabela de faltas da prova prática.
 *
 * ATENÇÃO: a gravidade de cada falta e o limite de pontos seguem a estrutura das
 * resoluções do CONTRAN (eliminatória / grave / média / leve), mas os valores
 * exatos mudaram ao longo dos anos e variam na aplicação de cada DETRAN.
 * Confira a resolução vigente antes de tratar isso como oficial — tudo aqui é
 * configurável.
 */
export type Gravidade = 'eliminatoria' | 'grave' | 'media' | 'leve';

export const PONTOS: Record<Gravidade, number> = {
  eliminatoria: 0,
  grave: 3,
  media: 2,
  leve: 1,
};

/** Reprova se passar disto (ou se cometer qualquer eliminatória). */
export const LIMITE_PONTOS = 10;

/** Tempo máximo para a baliza (s). */
export const TEMPO_BALIZA = 5 * 60;

export interface Regra {
  descricao: string;
  gravidade: Gravidade;
}

export const REGRAS = {
  avancou_vermelho: { descricao: 'Avançou o sinal vermelho do semáforo', gravidade: 'eliminatoria' },
  baliza_tempo: { descricao: 'Não completou a baliza no tempo', gravidade: 'eliminatoria' },
  subiu_calcada: { descricao: 'Subiu na calçada / meio-fio', gravidade: 'grave' },
  tocou_baliza: { descricao: 'Tocou em baliza', gravidade: 'grave' },
  sem_cinto: { descricao: 'Iniciou a prova sem cinto de segurança', gravidade: 'grave' },
  recuou_rampa: { descricao: 'Deixou o veículo recuar na rampa', gravidade: 'grave' },
  motor_apagou: { descricao: 'Deixou o motor apagar', gravidade: 'media' },
  banguela: { descricao: 'Desengrenou o veículo em declive (banguela)', gravidade: 'media' },
  sem_seta: { descricao: 'Saiu sem sinalizar com a seta', gravidade: 'media' },
  parou_faixa: { descricao: 'Parou sobre a faixa de pedestres', gravidade: 'media' },
  tocou_cone: { descricao: 'Tocou em cone', gravidade: 'media' },
  freio_de_mao: { descricao: 'Movimentou o veículo com o freio de mão puxado', gravidade: 'leve' },
  arranhou_marcha: { descricao: 'Engrenou a marcha sem a embreagem (arranhou)', gravidade: 'leve' },
} satisfies Record<string, Regra>;

export type CodigoFalta = keyof typeof REGRAS;
