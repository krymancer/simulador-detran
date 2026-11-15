/**
 * Tabela de faltas da prova prática (exame de direção veicular, categoria B).
 *
 * FONTE: Resolução CONTRAN nº 1.020, de 1º de dezembro de 2025 (DOU de 09/12/2025),
 * que REVOGOU a Resolução CONTRAN nº 789/2020 (art. 140, IV).
 * https://www.in.gov.br/web/dou/-/resolucao-contran-n-1.020-de-1-de-dezembro-de-2025-674131330
 *
 *  - Art. 45: o candidato começa com zero pontos; "cada infração de trânsito cometida
 *    corresponderá a um ponto, multiplicado pelo respectivo peso": leve = 1, média = 2,
 *    grave = 4, gravíssima = 6 (natureza da infração segundo o CTB).
 *  - Art. 47: aprovado com nota "não superior a dez pontos".
 *  - Não existe mais falta eliminatória (a 789/2020 reprovava com uma eliminatória ou
 *    mais de 3 pontos, com grave = 3, média = 2, leve = 1).
 *  - Art. 46 e art. 43, II: o exame pode ser INTERROMPIDO (fica "não concluído, sem nota").
 *    Aqui isso vira a gravidade 'eliminatoria' (nome mantido por compatibilidade), usada
 *    só para colisão e atropelamento: o examinador interrompe a prova por segurança.
 *
 * Como a 1.020 pontua INFRAÇÕES DE TRÂNSITO do CTB, cada falta abaixo cita o artigo
 * do CTB usado para a natureza. Faltas que não são infração do CTB (técnica de
 * direção: motor apagar, arranhar marcha, baliza, cones…) dependem de procedimento
 * próprio do DETRAN enquanto o "Manual Brasileiro de Exames de Direção Veicular"
 * (art. 42, parágrafo único) não sai — os pesos delas aqui são ESCOLHA NOSSA e estão
 * marcados como tal. Tudo é configurável.
 */
export type Gravidade = 'eliminatoria' | 'gravissima' | 'grave' | 'media' | 'leve';

/** Pesos do art. 45, § 1º. 'eliminatoria' = prova interrompida (não soma pontos, reprova). */
export const PONTOS: Record<Gravidade, number> = {
  eliminatoria: 0,
  gravissima: 6,
  grave: 4,
  media: 2,
  leve: 1,
};

/** Art. 47: aprovado se a nota não passar disto (e a prova não tiver sido interrompida). */
export const LIMITE_PONTOS = 10;

/** Tempo máximo para a baliza (s) — procedimento do DETRAN, não da resolução. */
export const TEMPO_BALIZA = 5 * 60;

/** Velocidade máxima da pista (placa R-19 de 30 km/h), em m/s. */
export const VELOCIDADE_MAXIMA_KMH = 30;
export const VELOCIDADE_MAXIMA = VELOCIDADE_MAXIMA_KMH / 3.6;

/** Rotação acima da qual o motor está sendo maltratado (rpm), e por quanto tempo (s). */
export const RPM_EXCESSIVA = 4500;
export const TEMPO_RPM_EXCESSIVA = 3;

/** Desaceleração (m/s²) a partir da qual a frenagem é "brusca". */
export const DESACELERACAO_BRUSCA = 6;

export const ROTULO_GRAVIDADE: Record<Gravidade, string> = {
  eliminatoria: 'interrompe a prova',
  gravissima: 'gravíssima',
  grave: 'grave',
  media: 'média',
  leve: 'leve',
};

export interface Regra {
  descricao: string;
  gravidade: Gravidade;
}

export const REGRAS = {
  // --- Prova interrompida (art. 46 / art. 43, II da Res. 1.020) — reprova
  colisao: { descricao: 'Colidiu com outro veículo (prova interrompida)', gravidade: 'eliminatoria' },
  atropelamento: { descricao: 'Atropelou um pedestre (prova interrompida)', gravidade: 'eliminatoria' },

  // --- Gravíssimas (6 pt)
  avancou_vermelho: { descricao: 'Avançou o sinal vermelho do semáforo (CTB art. 208)', gravidade: 'gravissima' },
  nao_parou_pare: { descricao: 'Não parou na placa PARE (CTB art. 208)', gravidade: 'gravissima' },
  subiu_calcada: { descricao: 'Subiu na calçada / meio-fio (CTB art. 193)', gravidade: 'gravissima' },
  preferencia_pedestre: {
    descricao: 'Não deu preferência ao pedestre na faixa (CTB art. 214, I)',
    gravidade: 'gravissima',
  },
  contramao_mao_unica: {
    descricao: 'Transitou na contramão em via de sentido único (CTB art. 186, II)',
    gravidade: 'gravissima',
  },

  // --- Graves (4 pt)
  contramao: { descricao: 'Transitou na contramão em via de mão dupla (CTB art. 186, I)', gravidade: 'grave' },
  // Sem ultrapassagem não cabe o art. 203, V (gravíssima); tratamos como ocupar a faixa
  // da contramão (art. 186, I). Leitura nossa — os DETRANs variam.
  linha_divisoria: {
    descricao: 'Transpôs a linha divisória amarela contínua (CTB art. 186, I)',
    gravidade: 'grave',
  },
  sem_cinto: { descricao: 'Iniciou a prova sem cinto de segurança (CTB art. 167)', gravidade: 'grave' },
  sem_seta: { descricao: 'Saiu da vaga sem sinalizar com a seta (CTB art. 196)', gravidade: 'grave' },
  conversao_sem_seta: {
    descricao: 'Converteu ou mudou de faixa sem sinalizar com a seta (CTB art. 196)',
    gravidade: 'grave',
  },
  // Procedimento do DETRAN (sem natureza no CTB): pesos escolhidos aqui.
  derrubou_baliza: { descricao: 'Derrubou baliza (procedimento do DETRAN)', gravidade: 'grave' },
  baliza_tempo: { descricao: 'Não completou a baliza no tempo (procedimento do DETRAN)', gravidade: 'grave' },

  // --- Médias (2 pt)
  // Excesso de velocidade: CTB art. 218 — até 20 % acima = média; 20–50 % = grave;
  // acima de 50 % = gravíssima. A gravidade é decidida na hora (ver exam.ts).
  excesso_velocidade: { descricao: 'Excedeu a velocidade máxima de 30 km/h (CTB art. 218)', gravidade: 'media' },
  banguela: { descricao: 'Desengrenou o veículo em declive (banguela, CTB art. 231, IX)', gravidade: 'media' },
  parou_faixa: { descricao: 'Parou sobre a faixa de pedestres (CTB art. 183)', gravidade: 'media' },
  // Procedimento do DETRAN (sem natureza no CTB): pesos escolhidos aqui.
  tocou_baliza: { descricao: 'Tocou em baliza (procedimento do DETRAN)', gravidade: 'media' },
  tocou_cone: { descricao: 'Tocou em cone (procedimento do DETRAN)', gravidade: 'media' },
  recuou_rampa: { descricao: 'Deixou o veículo recuar na rampa', gravidade: 'media' },

  // --- Leves (1 pt)
  // CTB art. 42 proíbe frear bruscamente sem razão de segurança; sem penalidade própria,
  // enquadramos em "dirigir sem atenção ou sem os cuidados indispensáveis" (art. 169, leve).
  freada_brusca: { descricao: 'Freou bruscamente sem necessidade (CTB art. 42 / art. 169)', gravidade: 'leve' },
  // Técnica de direção / uso dos equipamentos — sem natureza no CTB: leves por escolha nossa.
  motor_apagou: { descricao: 'Deixou o motor apagar', gravidade: 'leve' },
  freio_de_mao: { descricao: 'Movimentou o veículo com o freio de mão puxado', gravidade: 'leve' },
  arranhou_marcha: { descricao: 'Engrenou a marcha sem a embreagem (arranhou)', gravidade: 'leve' },
  rotacao_excessiva: { descricao: 'Manteve o motor em rotação excessiva', gravidade: 'leve' },
  // O preposto "transmite as instruções necessárias à execução do trajeto" (art. 43, I);
  // errar o trajeto não é infração do CTB — leve por escolha nossa.
  nao_seguiu_instrucao: { descricao: 'Não seguiu a instrução do examinador', gravidade: 'leve' },
} satisfies Record<string, Regra>;

export type CodigoFalta = keyof typeof REGRAS;
