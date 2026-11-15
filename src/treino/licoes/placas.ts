import { naFaixa, PosePlanta } from '../geo';
import { DefLicao, leitura, Passo } from '../passo';
import type { Quiz } from '../tipos';

/**
 * Lição 3 — Sinalização e placas: um passeio pelas placas e marcas da pista. Para cada uma,
 * o carro é colocado parado na faixa, de frente para a placa; o treino explica e faz
 * uma pergunta rápida (botões no painel, teclas 1–3 / câmbio 1ª–3ª, ou direcional no controle).
 *
 * As posições repetem as de `world/autoescolaDecoracao.ts` (lista PLACAS) e `world/ferrovia.ts`
 * (PLACAS_FERROVIA_PX, cancelas): se elas mudarem lá, ajuste aqui.
 */

interface Parada {
  id: string;
  titulo: string;
  /** Onde o carro fica (px + yaw). Sem pose: o carro não sai do lugar. */
  pose?: () => PosePlanta;
  explicacao: string;
  quiz: Quiz;
}

const PARADAS: Parada[] = [
  {
    id: 'r1',
    titulo: 'R-1 — Parada obrigatória (PARE)',
    pose: () => naFaixa('anel_externo', 440, 1312, 10), // rua de baixo, antes da passagem de nível
    explicacao: 'Esta é a placa PARE, um octógono vermelho. Ela é uma ordem: você tem de parar o carro totalmente antes da linha, olhar para os dois lados e só seguir quando estiver livre. Diminuir e passar devagar não vale.',
    quiz: {
      pergunta: 'Na placa PARE, o que você deve fazer?',
      opcoes: ['Diminuir e passar se não vier ninguém', 'Parar totalmente, olhar e só então seguir', 'Buzinar e seguir'],
      correta: 1,
      explicacao: 'Na placa PARE é preciso parar totalmente, mesmo se não vier ninguém.',
    },
  },
  {
    id: 'r2',
    titulo: 'R-2 — Dê a preferência',
    explicacao: 'Esta placa não está nesta pista, mas você vai vê-la muito na rua: um triângulo branco de borda vermelha, com a ponta para baixo. Ela manda dar a preferência: diminua e, se vier alguém pela outra via, pare e espere. Se estiver livre, pode seguir sem parar.',
    quiz: {
      pergunta: 'Qual a diferença entre PARE e Dê a preferência?',
      opcoes: ['No PARE você sempre para; no Dê a preferência só para se vier alguém', 'Nenhuma, as duas são iguais', 'Dê a preferência é só para caminhões'],
      correta: 0,
      explicacao: 'No PARE a parada é sempre obrigatória; no Dê a preferência você só para se precisar.',
    },
  },
  {
    id: 'a6',
    titulo: 'A-6 — Cruzamento de vias',
    pose: () => naFaixa('anel_externo', 540, 1392, 14),
    explicacao: 'Placas amarelas em forma de losango são de advertência: avisam de um perigo à frente. Esta, a A-6, avisa que outra rua cruza a sua logo adiante. Diminua e fique atento a quem vem dos lados.',
    quiz: {
      pergunta: 'Placas amarelas em forma de losango são de:',
      opcoes: ['Regulamentação (ordens)', 'Indicação (nomes de lugares)', 'Advertência (aviso de perigo)'],
      correta: 2,
      explicacao: 'Amarelas em losango são placas de advertência.',
    },
  },
  {
    id: 'a40',
    titulo: 'A-40 — Passagem de nível com barreira',
    pose: () => naFaixa('anel_externo', 42, 930, 14),
    explicacao: 'A placa A-40 avisa que há uma linha de trem à frente, com cancela. Diminua a velocidade e prepare-se para parar antes dos trilhos.',
    quiz: {
      pergunta: 'O que a placa A-40 avisa?',
      opcoes: ['Linha de trem com cancela à frente', 'Estacionamento à frente', 'Ponte estreita'],
      correta: 0,
      explicacao: 'A A-40 avisa de uma passagem de nível, com barreira (cancela).',
    },
  },
  {
    id: 'cruz',
    titulo: 'Cruz de Santo André e a linha férrea',
    pose: () => naFaixa('anel_externo', 440, 1312, 3),
    explicacao: 'O X branco e vermelho é a Cruz de Santo André: ele marca o próprio cruzamento com o trem. O trem sempre tem a preferência. Pare antes da cancela, olhe para os dois lados e só atravesse com a passagem livre. Se as luzes piscarem ou a cancela descer, espere o trem passar.',
    quiz: {
      pergunta: 'Chegando à linha do trem com as luzes piscando, você:',
      opcoes: ['Acelera para passar antes do trem', 'Para em cima dos trilhos para olhar', 'Para antes da cancela e espera'],
      correta: 2,
      explicacao: 'Com as luzes piscando, pare antes da cancela e espere o trem passar e as luzes apagarem.',
    },
  },
  {
    id: 'faixas_amarelas',
    titulo: 'Linha amarela: contínua e tracejada',
    pose: () => naFaixa('anel_externo', 860, 1312, 0),
    explicacao: 'A linha amarela no meio da rua separa os dois sentidos. Contínua: é proibido cruzar ou ultrapassar. Tracejada: pode cruzar para ultrapassar, com cuidado e com a pista livre. As linhas brancas separam faixas do mesmo sentido.',
    quiz: {
      pergunta: 'Linha amarela contínua no meio da rua significa:',
      opcoes: ['Pode ultrapassar', 'Proibido cruzar ou ultrapassar', 'Pode estacionar'],
      correta: 1,
      explicacao: 'Linha amarela contínua: proibido cruzar e ultrapassar.',
    },
  },
  {
    id: 'r19',
    titulo: 'R-19 — Velocidade máxima 30 km/h',
    pose: () => naFaixa('anel_interno', 258, 1000, 6),
    explicacao: 'Placas redondas com borda vermelha são de regulamentação: são ordens. Esta, a R-19, diz que a velocidade máxima aqui é 30 quilômetros por hora. Passar disso é infração.',
    quiz: {
      pergunta: 'O que significa o 30 na placa redonda de borda vermelha?',
      opcoes: ['Velocidade mínima de 30 km/h', 'Velocidade máxima de 30 km/h', 'Faltam 30 metros para o cruzamento'],
      correta: 1,
      explicacao: 'É a velocidade máxima permitida: 30 km/h.',
    },
  },
  {
    id: 'a14',
    titulo: 'A-14 — Semáforo à frente',
    pose: () => naFaixa('anel_interno', 300, 470, 14),
    explicacao: 'A A-14 avisa que há um semáforo logo adiante. Fique pronto para parar: no vermelho você para antes da linha; no amarelo você para se der para parar com segurança.',
    quiz: {
      pergunta: 'Com o sinal amarelo, você deve:',
      opcoes: ['Acelerar para passar antes do vermelho', 'Buzinar', 'Parar, se der para parar com segurança'],
      correta: 2,
      explicacao: 'O amarelo pede para parar, se der para parar com segurança.',
    },
  },
  {
    id: 'a2b',
    titulo: 'A-2b — Curva à direita',
    pose: () => naFaixa('anel_interno', 325, 330, 12),
    explicacao: 'A A-2b avisa que vem uma curva para a direita. Diminua a velocidade antes de entrar na curva, não dentro dela, e mantenha o carro na sua faixa.',
    quiz: {
      pergunta: 'Quando diminuir a velocidade numa curva?',
      opcoes: ['Antes de entrar na curva', 'No meio da curva', 'Depois da curva'],
      correta: 0,
      explicacao: 'Freie e reduza antes da curva; dentro dela, mantenha a velocidade.',
    },
  },
  {
    id: 'a32b',
    titulo: 'A-32b — Passagem de pedestres',
    pose: () => naFaixa('anel_interno', 430, 60, 12),
    explicacao: 'A A-32b avisa que há uma faixa de pedestres à frente. Diminua: quem está atravessando na faixa tem a preferência.',
    quiz: {
      pergunta: 'Há um pedestre atravessando na faixa. Você:',
      opcoes: ['Buzina para ele andar mais rápido', 'Para e espera ele terminar de atravessar', 'Passa por trás dele'],
      correta: 1,
      explicacao: 'Pare e espere: o pedestre na faixa tem a preferência.',
    },
  },
  {
    id: 'retencao',
    titulo: 'Linha de retenção e faixa de pedestres',
    pose: () => naFaixa('diagonal_2', 727, 280, 10),
    explicacao: 'Lá na frente, a linha branca atravessada na pista é a linha de retenção: com o sinal vermelho, pare antes dela. Logo depois vem a faixa de pedestres, as listras brancas: nunca pare em cima dela.',
    quiz: {
      pergunta: 'Sinal vermelho: onde o carro deve parar?',
      opcoes: ['Em cima da faixa de pedestres', 'Depois do semáforo', 'Antes da linha de retenção'],
      correta: 2,
      explicacao: 'Pare antes da linha de retenção, deixando a faixa de pedestres livre.',
    },
  },
  {
    id: 'r6a',
    titulo: 'R-6a — Proibido estacionar',
    pose: () => naFaixa('diagonal_3', 1240, 860, 12),
    explicacao: 'A R-6a proíbe estacionar: você pode parar rapidinho para alguém embarcar ou desembarcar, mas não pode deixar o carro ali. As áreas com um X pintado, o zebrado, também não são lugar de parar.',
    quiz: {
      pergunta: 'Com a placa Proibido estacionar, você pode:',
      opcoes: ['Deixar o carro e ir às compras', 'Estacionar se ligar o pisca-alerta', 'Parar só para alguém embarcar ou desembarcar'],
      correta: 2,
      explicacao: 'Parar rapidinho para embarque e desembarque pode; estacionar, não.',
    },
  },
];

function passosDe(p: Parada): Passo[] {
  return [
    leitura(p.id, p.titulo, p.explicacao, 'frente', {
      aoIniciar: (x) => {
        if (!p.pose) return;
        const q = p.pose();
        x.teleportar(q.x, q.y, q.yaw);
      },
    }),
    {
      id: `${p.id}_quiz`,
      titulo: `Pergunta — ${p.titulo.split(' — ')[0]}`,
      foco: 'frente',
      texto: 'Responda:',
      quiz: p.quiz,
    },
  ];
}

export const LICAO_PLACAS: DefLicao = {
  id: 'placas',
  titulo: 'Sinalização e placas',
  descricao: 'Um passeio pelas placas e marcas da pista: PARE, preferência, velocidade, semáforo, curvas, pedestres, linha do trem e faixas pintadas — com perguntas rápidas.',
  passos: [
    leitura('intro', 'Placas e sinalização',
      'Vamos passear pelas placas da pista. Eu coloco o carro na frente de cada uma, explico, e depois faço uma pergunta. Responda com os botões do painel. Existem três tipos principais: redondas são ordens, amarelas em losango são avisos de perigo, e as pinturas no chão também são sinalização.',
      'frente'),
    ...PARADAS.flatMap(passosDe),
  ],
  resumo: (x) => `Você acertou ${x.licao.acertos ?? 0} de ${x.licao.perguntas ?? 0} perguntas.`,
};
