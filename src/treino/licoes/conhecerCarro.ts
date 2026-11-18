import { clamp01, DefLicao, Exec, leitura, Passo, segurar, sequencia } from '../passo';
import { comoEngatar, comoNeutro, engatada, nomeMarcha, partidaTexto } from './comum';

/** Lição 1 — Conhecendo o carro e os comandos (parado, motor desligado no começo). */

/** Pisar um pedal até o fundo e soltar. */
function pedal(id: string, titulo: string, acao: 'embreagem' | 'freio' | 'acelerador', explica: string): Passo {
  const valor = (x: Exec) => x.ent[acao];
  return {
    id,
    titulo,
    foco: 'pedais',
    texto: (x) => `${explica} Pise ${acao === 'embreagem' ? 'a embreagem' : acao === 'freio' ? 'o freio' : 'o acelerador'} até o fundo e depois solte. No seu controle: ${x.nome(acao)}.`,
    dica: (x) => `Procure ${x.nome(acao)}. ${x.dispositivo === 'volante' ? 'Os pedais do G29 são, da esquerda para a direita: embreagem, freio e acelerador.' : ''}`,
    detectar: (x) => sequencia(x, 's', [() => valor(x) > 0.9, () => valor(x) < 0.1]) >= 2,
    progresso: (x) => ((x.mem.s ?? 0) >= 1 ? 0.5 + 0.5 * (1 - valor(x)) : 0.5 * clamp01(valor(x) / 0.9)),
    rotuloProgresso: 'Pedal',
  };
}

function ligarDesligar(id: string, titulo: string, campo: 'farol' | 'alerta', acao: 'farol' | 'alerta', explica: string): Passo {
  return {
    id,
    titulo,
    foco: 'painel',
    texto: (x) => `${explica} Ligue (${x.nome(acao)}), veja a luz no painel, e desligue de novo.`,
    detectar: (x) => sequencia(x, 's', [() => x.ent[campo], () => !x.ent[campo]]) >= 2,
    progresso: (x) => (x.mem.s ?? 0) / 2,
  };
}

const MARCHAS_TREINO = [1, 2, 3, -1];

export const LICAO_CONHECER: DefLicao = {
  id: 'conhecer_carro',
  titulo: 'Conhecendo o carro e os comandos',
  descricao: 'Volante, pedais, câmbio, freio de mão, espelhos, painel, setas e luzes — e os comandos do jogo. O carro fica parado.',
  passos: [
    leitura('boas_vindas', 'Bem-vindo ao carro',
      'Você está no banco do motorista. Antes de andar, vamos conhecer cada comando do carro e onde ele fica no seu controle. É só fazer o que eu pedir: o treino avança sozinho.',
      'frente'),
    {
      id: 'cinto',
      titulo: 'Cinto de segurança',
      foco: 'painel',
      texto: (x) => `A primeira coisa ao entrar no carro: colocar o cinto. Sem ele, a prova já começa com falta. Coloque o cinto (${x.nome('cinto')}).`,
      dica: 'A luz vermelha do cinto no painel apaga quando ele está colocado.',
      detectar: (x) => x.ent.cinto,
    },
    {
      id: 'volante',
      titulo: 'Volante',
      foco: 'volante',
      texto: (x) =>
        x.dispositivo === 'volante'
          ? 'Este é o volante: ele vira as rodas da frente. Gire o volante todo para a esquerda, depois todo para a direita, e volte para o centro.'
          : `Este é o volante: ele vira as rodas da frente. Vire para a esquerda (${x.nome('volante')}), depois para a direita, e volte para o centro.`,
      dica: 'Segure o volante com as duas mãos, como os ponteiros de um relógio marcando 9 e 15.',
      detectar: (x) => sequencia(x, 's', [() => x.ent.volante < -0.5, () => x.ent.volante > 0.5, () => Math.abs(x.ent.volante) < 0.15]) >= 3,
      progresso: (x) => (x.mem.s ?? 0) / 3,
    },
    pedal('embreagem', 'Embreagem (pedal da esquerda)', 'embreagem',
      'O pedal da esquerda é a embreagem: ela desliga o motor das rodas. Você pisa nela para dar a partida, para trocar de marcha e para parar.'),
    pedal('freio', 'Freio (pedal do meio)', 'freio',
      'O pedal do meio é o freio. Use o pé direito nele, sempre com calma: pisar devagar e firme.'),
    pedal('acelerador', 'Acelerador (pedal da direita)', 'acelerador',
      'O pedal da direita é o acelerador. Com o pé direito você escolhe: ou acelera, ou freia, nunca os dois ao mesmo tempo.'),
    leitura('cambio_intro', 'O câmbio',
      (x) =>
        x.dispositivo === 'volante'
          ? 'Este é o câmbio. As marchas ficam num desenho de H: primeira à esquerda na frente, segunda à esquerda atrás, terceira no meio na frente, quarta no meio atrás, quinta à direita na frente. A ré, no câmbio do G29, é empurrando a alavanca para baixo e indo para a direita e para trás. No meio, solta, a alavanca fica em neutro. Sempre troque com a embreagem pisada até o fundo.'
          : x.dispositivo === 'controle'
            ? `Este é o câmbio. No controle as marchas são em sequência: ${x.nome('marchaMais')} sobe uma marcha e ${x.nome('marchaMenos')} desce. A ordem é: ré, neutro, primeira, segunda, terceira, quarta e quinta. Sempre troque com a embreagem pisada até o fundo.`
            : x.dispositivo === 'toque'
              ? 'Este é o câmbio. Na tela ele fica à direita, desenhado como o H de um carro de verdade: primeira, terceira e quinta em cima; segunda, quarta e ré embaixo; N no meio é o neutro. Toque ou arraste o dedo até a marcha. Sempre troque com a embreagem no fundo: o pedal Embreagem, à esquerda, com o dedo lá em cima.'
              : 'Este é o câmbio. No teclado, as teclas de 1 a 5 escolhem a marcha, R é a ré e N é o neutro. Num carro de verdade, a alavanca faz um desenho de H. Sempre troque com a embreagem pisada até o fundo.',
      'cambio'),
    {
      id: 'marchas',
      titulo: 'Engatando as marchas',
      foco: 'cambio',
      texto: (x) => {
        const i = Math.min(x.mem.s ?? 0, MARCHAS_TREINO.length - 1);
        const m = MARCHAS_TREINO[i];
        return `Pise a embreagem até o fundo e engate a ${nomeMarcha(m)}: ${comoEngatar(x, m)}. Vamos passar por primeira, segunda, terceira e ré.`;
      },
      dica: (x) => `Primeiro a embreagem no fundo (${x.nome('embreagem')}), só depois mexa no câmbio.`,
      detectar: (x) => {
        if (x.ent.marcha !== 0 && x.ent.embreagem < 0.5 && !x.mem.avisou) {
          x.mem.avisou = true;
          x.avisar('Lembre: pise a embreagem até o fundo antes de trocar a marcha.', 'info', true);
        }
        const n = sequencia(x, 's', MARCHAS_TREINO.map((m) => () => engatada(x, m) && x.ent.embreagem > 0.7));
        return n >= MARCHAS_TREINO.length;
      },
      progresso: (x) => (x.mem.s ?? 0) / MARCHAS_TREINO.length,
      rotuloProgresso: 'Marchas',
    },
    {
      id: 'neutro',
      titulo: 'Neutro (ponto morto)',
      foco: 'cambio',
      texto: (x) => `Agora volte para o neutro: ${comoNeutro(x)}. Em neutro o motor não empurra o carro. É assim que se dá a partida.`,
      detectar: (x) => engatada(x, 0),
    },
    {
      id: 'freio_de_mao',
      titulo: 'Freio de mão',
      foco: 'freioDeMao',
      texto: (x) => `Este é o freio de mão: ele segura o carro parado. Solte o freio de mão (${x.nome('freioDeMao')}) e depois puxe de novo.`,
      dica: 'Quando o freio de mão está puxado, acende uma luz vermelha (P) no painel.',
      detectar: (x) => sequencia(x, 's', [() => !x.ent.freioDeMao, () => x.ent.freioDeMao]) >= 2,
      progresso: (x) => (x.mem.s ?? 0) / 2,
    },
    {
      id: 'partida',
      titulo: 'Dar a partida',
      foco: 'volante',
      texto: (x) => `Hora de ligar o motor. ${partidaTexto(x)}`,
      dica: (x) => `Segure ${x.nome('partida')} por um ou dois segundos. Se o carro estiver engatado, ele não pega: coloque em neutro.`,
      detectar: (x) => x.trem.ligado,
      festa: 'Motor ligado! Muito bem!',
    },
    {
      id: 'painel',
      titulo: 'Painel: conta-giros e velocímetro',
      foco: 'painel',
      requerMotor: true,
      aoApagar: 'partida',
      texto: (x) => `No painel, o velocímetro mostra a velocidade e o conta-giros mostra o giro do motor (rpm). Parado, em neutro, o giro fica perto de 850. Acelere um pouco (${x.nome('acelerador')}) e veja o conta-giros passar de 2000.`,
      detectar: (x) => x.trem.marchaEngatada === 0 && x.trem.rpm > 2000,
      progresso: (x) => clamp01((x.trem.rpm - 850) / 1150),
      rotuloProgresso: 'Giro do motor',
    },
    leitura('luzes_espia', 'Luzes do painel',
      'As luzes do painel avisam: a luz vermelha com P é o freio de mão puxado; o boneco com cinto é o cinto solto; a bateria e o óleo acendem com o motor desligado; as setinhas verdes piscam com a seta; e a luz azul é o farol alto. Com o motor ligado e tudo certo, só fica acesa a do freio de mão.',
      'painel'),
    {
      id: 'setas',
      titulo: 'Setas (pisca)',
      foco: 'painel',
      texto: (x) => `As setas avisam os outros para onde você vai virar. Ligue a seta para a esquerda (${x.nome('setaEsq')}), depois a seta para a direita (${x.nome('setaDir')}), e depois desligue.`,
      dica: (x) => `Apertar a mesma seta de novo desliga (${x.nome('setaDir')}). Ela também desliga sozinha quando o volante volta depois de uma curva.`,
      detectar: (x) => sequencia(x, 's', [() => x.ent.seta === 'esquerda', () => x.ent.seta === 'direita', () => x.ent.seta === null]) >= 3,
      progresso: (x) => (x.mem.s ?? 0) / 3,
    },
    ligarDesligar('farol', 'Farol', 'farol', 'farol',
      'O farol baixo serve para ver e ser visto: use à noite, na chuva, em túneis e nas rodovias.'),
    ligarDesligar('alerta', 'Pisca-alerta', 'alerta', 'alerta',
      'O pisca-alerta acende as duas setas juntas: use quando o carro estiver parado em emergência.'),
    leitura('espelho_centro', 'Espelho do meio', 'O retrovisor interno, no meio do para-brisa, mostra o que vem atrás do carro. Dê uma olhada nele sempre antes de frear, de mudar de faixa e de sair com o carro.', 'espelhoCentro'),
    {
      id: 'espelho_esq',
      titulo: 'Espelho esquerdo',
      foco: null,
      texto: (x) => `Agora o espelho da esquerda: vire a cabeça para a esquerda (${x.nome(x.dispositivo === 'controle' ? 'olhar' : 'olharEsq')}) e segure um pouco.`,
      dica: 'Se não acontecer nada, configure o comando "Olhar à esquerda" na tela de controles (F2).',
      detectar: (x) => segurar(x, 'o', x.ent.olhar < -0.6, 0.6),
      progresso: (x) => clamp01((x.mem.o ?? 0) / 0.6),
    },
    {
      id: 'espelho_dir',
      titulo: 'Espelho direito',
      foco: null,
      texto: (x) => `E o da direita: vire a cabeça para a direita (${x.nome(x.dispositivo === 'controle' ? 'olhar' : 'olharDir')}) e segure.`,
      detectar: (x) => segurar(x, 'o', x.ent.olhar > 0.6, 0.6),
      progresso: (x) => clamp01((x.mem.o ?? 0) / 0.6),
    },
    {
      id: 'olhar_tras',
      titulo: 'Olhar para trás',
      foco: null,
      texto: (x) => `Para dar ré e conferir o ponto cego, olhe para trás por cima do ombro: segure ${x.nome('olharTras')}.`,
      detectar: (x) => segurar(x, 'o', x.ent.olharTras, 0.6),
      progresso: (x) => clamp01((x.mem.o ?? 0) / 0.6),
    },
    {
      id: 'camera',
      titulo: 'Câmeras do jogo',
      foco: null,
      texto: (x) => `No jogo há três câmeras: de dentro do carro, de fora e de cima. Aperte ${x.nome('camera')} três vezes para ver todas e voltar para dentro do carro.`,
      detectar: (x) => {
        if (x.ent.bordas.has('camera')) x.mem.n = (x.mem.n ?? 0) + 1;
        return (x.mem.n ?? 0) >= 3;
      },
      progresso: (x) => (x.mem.n ?? 0) / 3,
    },
    leitura('telas', 'Telas e atalhos',
      (x) => `Mais alguns atalhos: F2 abre a tela de controles, para mudar qualquer botão ou pedal. A tecla O abre as opções (som, gráficos, voz). H mostra a ajuda. ${x.nome('reiniciar')} recoloca o carro no início, e ${x.nome('encerrar')} encerra a prova.`,
      null),
    {
      id: 'desligar',
      titulo: 'Desligar o motor',
      foco: 'volante',
      texto: (x) => `Por último, desligue o motor: aperte ${x.nome('partida')} uma vez, rapidinho.`,
      detectar: (x) => !x.trem.ligado,
      festa: 'Pronto! Você já conhece o carro.',
    },
  ],
  resumo: () => 'Agora você conhece o carro. A próxima lição é sair com o carro, trocar marchas e parar.',
};
