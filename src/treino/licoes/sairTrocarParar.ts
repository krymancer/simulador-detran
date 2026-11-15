import { naFaixa } from '../geo';
import { clamp01, DefLicao, Exec, leitura, segurar, sequencia } from '../passo';
import { assentado, comoEngatar, comoNeutro, engatada, partidaTexto, TORQUE_PONTO } from './comum';

/**
 * Lição 2 — Sair com o carro, trocar marchas e parar.
 * Começa na avenida (faixa do meio, ~38 m de reta larga, subindo para o norte).
 */

/** Onde o carro começa (px da planta + yaw). */
export const INICIO_SAIR = naFaixa('diagonal_2', 1052, 1095, 0);

/** Medidor do ponto da embreagem: torque passando pela embreagem (N·m), normalizado. */
export const ESCALA_PONTO = 30;
const pontoAtual = (x: Exec) => clamp01(Math.abs(x.trem.torqueEmbreagem) / ESCALA_PONTO);

export const LICAO_SAIR: DefLicao = {
  id: 'sair_trocar_parar',
  titulo: 'Sair com o carro, trocar marchas e parar',
  descricao: 'Partida, ponto da embreagem, sair sem deixar o motor morrer, passar a 2ª, reduzir e parar suavemente. Numa reta larga da avenida.',
  passos: [
    {
      id: 'preparar',
      titulo: 'Indo para a avenida',
      foco: 'frente',
      semFesta: true,
      texto: 'Vamos para uma reta calma da avenida. Aqui a pista é larga e reta: é só seguir em frente.',
      aoIniciar: (x) => x.teleportar(INICIO_SAIR.x, INICIO_SAIR.y, INICIO_SAIR.yaw),
      detectar: (x) => assentado(x) && x.t > 2.5,
    },
    {
      id: 'cinto',
      titulo: 'Cinto',
      foco: 'painel',
      texto: (x) => `Primeiro o cinto de segurança (${x.nome('cinto')}).`,
      detectar: (x) => x.ent.cinto,
    },
    {
      id: 'embreagem_neutro',
      titulo: 'Embreagem no fundo e neutro',
      foco: 'pedais',
      texto: (x) => `Pise a embreagem até o fundo (${x.nome('embreagem')}) e deixe o câmbio em neutro: ${comoNeutro(x)}.`,
      detectar: (x) => x.ent.embreagem > 0.9 && engatada(x, 0),
    },
    {
      id: 'partida',
      titulo: 'Partida',
      foco: 'volante',
      texto: (x) => `Com a embreagem no fundo, dê a partida. ${partidaTexto(x)}`,
      dica: (x) => `Segure ${x.nome('partida')} até ouvir o motor pegar (uns 2 segundos).`,
      detectar: (x) => x.trem.ligado,
    },
    {
      id: 'primeira',
      titulo: 'Engatar a 1ª',
      foco: 'cambio',
      requerMotor: true,
      aoApagar: 'partida',
      texto: (x) => `Mantenha a embreagem no fundo e engate a primeira marcha: ${comoEngatar(x, 1)}.`,
      dica: 'Se arranhar, é porque a embreagem não estava no fundo.',
      detectar: (x) => engatada(x, 1) && x.ent.embreagem > 0.7,
    },
    {
      id: 'ponto',
      titulo: 'Achar o ponto da embreagem',
      foco: 'painel',
      requerMotor: true,
      aoApagar: 'primeira',
      texto: 'Agora, bem devagar, vá soltando a embreagem até o ponto: o giro do motor cai um pouquinho, o som fica mais grave e o carro quer andar. Pare de soltar aí e segure o pedal parado nesse ponto.',
      dica: 'O ponto fica mais ou menos no meio do curso do pedal. Se o motor começar a tremer, pise um pouco de volta. O medidor verde mostra quando você está no ponto.',
      detectar: (x) =>
        (engatada(x, 1) && x.sim.carro.velocidade() < 0.3 && Math.abs(x.trem.torqueEmbreagem) >= TORQUE_PONTO && x.trem.rpm > 550 && segurar(x, 'p', true, 0.8)) ||
        (engatada(x, 1) && !x.ent.freioDeMao && x.sim.carro.velocidade() > 0.3),
      progresso: pontoAtual,
      rotuloProgresso: 'Ponto da embreagem',
      faixaBoa: [TORQUE_PONTO / ESCALA_PONTO, 0.85],
      festa: 'Isso! Esse é o ponto da embreagem.',
    },
    {
      id: 'soltar_freio_mao',
      titulo: 'Soltar o freio de mão',
      foco: 'freioDeMao',
      requerMotor: true,
      aoApagar: 'primeira',
      texto: (x) => `Segurando a embreagem no ponto, solte o freio de mão (${x.nome('freioDeMao')}).`,
      detectar: (x) => !x.ent.freioDeMao,
      progresso: pontoAtual,
      rotuloProgresso: 'Ponto da embreagem',
      faixaBoa: [TORQUE_PONTO / ESCALA_PONTO, 0.85],
    },
    {
      id: 'sair',
      titulo: 'Sair sem deixar o motor morrer',
      foco: null,
      requerMotor: true,
      aoApagar: 'primeira',
      texto: (x) => `Acelere só um pouquinho (${x.nome('acelerador')}) e continue soltando a embreagem devagar, até o fim. O carro vai andar. Mantenha o volante reto.`,
      dica: 'Acelerador e embreagem trabalham juntos: um pé sobe enquanto o outro desce, devagar. Se o carro tremer, segure a embreagem onde está e acelere um pouco mais.',
      detectar: (x) => x.sim.carro.velocidade() > 1.5 && x.ent.embreagem < 0.15,
      progresso: (x) => clamp01(1 - x.ent.embreagem / 0.7),
      rotuloProgresso: 'Embreagem solta',
      festa: 'Muito bem! O carro saiu sem morrer.',
    },
    {
      id: 'acelerar_1',
      titulo: 'Acelerar em 1ª',
      foco: null,
      requerMotor: true,
      aoApagar: 'primeira',
      texto: 'Acelere com calma até uns 15 a 20 quilômetros por hora. Ouça o motor subindo de giro: em primeira o carro ganha velocidade rápido.',
      detectar: (x) => engatada(x, 1) && x.kmh() >= 15,
      progresso: (x) => clamp01(x.kmh() / 15),
      rotuloProgresso: 'Velocidade',
    },
    {
      id: 'segunda',
      titulo: 'Passar a 2ª',
      foco: null,
      requerMotor: true,
      aoApagar: 'primeira',
      texto: (x) => {
        const n = x.mem.s ?? 0;
        if (n === 0) return `Hora de trocar: tire o pé do acelerador e pise a embreagem até o fundo (${x.nome('embreagem')}).`;
        if (n === 1) return `Agora engate a segunda: ${comoEngatar(x, 2)}.`;
        return 'Solte a embreagem com calma e volte a acelerar devagar.';
      },
      dica: 'A troca é: tira o pé do acelerador, embreagem no fundo, troca a marcha, solta a embreagem e acelera. Sem pressa.',
      detectar: (x) =>
        sequencia(x, 's', [
          () => x.ent.embreagem > 0.75 && x.ent.acelerador < 0.1,
          () => engatada(x, 2),
          () => engatada(x, 2) && x.ent.embreagem < 0.15 && x.sim.carro.velocidade() > 2,
        ]) >= 3,
      progresso: (x) => (x.mem.s ?? 0) / 3,
      festa: 'Ótimo! Você está em segunda.',
    },
    {
      id: 'manter_2',
      titulo: 'Andar em 2ª',
      foco: null,
      requerMotor: true,
      aoApagar: 'primeira',
      texto: 'Mantenha uns 20 quilômetros por hora em segunda por alguns segundos. Veja no conta-giros: o giro ficou mais baixo que na primeira.',
      detectar: (x) => segurar(x, 'v', engatada(x, 2) && x.kmh() > 14, 2),
      progresso: (x) => clamp01((x.mem.v ?? 0) / 2),
    },
    {
      id: 'reduzir',
      titulo: 'Diminuir e reduzir para a 1ª',
      foco: null,
      requerMotor: true,
      aoApagar: 'primeira',
      texto: (x) => {
        const n = x.mem.s ?? 0;
        if (n === 0) return `Olhe o espelho, tire o pé do acelerador e freie devagar (${x.nome('freio')}) até uns 10 quilômetros por hora.`;
        if (n === 1) return `Agora pise a embreagem e reduza para a primeira: ${comoEngatar(x, 1)}.`;
        return 'Solte a embreagem devagar. O carro segura um pouco: é o freio-motor.';
      },
      dica: 'Reduzir é descer de marcha quando o carro fica lento. Para a 1ª, a velocidade tem de estar baixa (até uns 15 km/h).',
      detectar: (x) =>
        sequencia(x, 's', [
          () => x.kmh() < 15,
          () => engatada(x, 1) && x.ent.embreagem > 0.7,
          () => engatada(x, 1) && x.ent.embreagem < 0.3,
        ]) >= 3,
      progresso: (x) => (x.mem.s ?? 0) / 3,
    },
    {
      id: 'parar',
      titulo: 'Parar suavemente',
      foco: null,
      requerMotor: true,
      texto: (x) => `Agora pare: pise a embreagem até o fundo (${x.nome('embreagem')}) e freie devagar até o carro parar. A embreagem vai antes, para o motor não morrer.`,
      dica: 'Antes do carro parar, a embreagem tem de estar no fundo. Freie aos poucos, aliviando o pé no finalzinho para não dar tranco.',
      detectar: (x) => segurar(x, 'p', x.sim.carro.velocidade() < 0.1 && x.ent.embreagem > 0.75 && x.trem.ligado, 1),
      progresso: (x) => clamp01(1 - x.kmh() / 12),
      rotuloProgresso: 'Parando',
      festa: 'Parou certinho, sem deixar o motor morrer!',
    },
    {
      id: 'neutro',
      titulo: 'Neutro',
      foco: 'cambio',
      texto: (x) => `Parado, coloque em neutro: ${comoNeutro(x)}. Depois pode soltar a embreagem.`,
      detectar: (x) => engatada(x, 0),
    },
    {
      id: 'freio_mao',
      titulo: 'Puxar o freio de mão',
      foco: 'freioDeMao',
      texto: (x) => `E puxe o freio de mão (${x.nome('freioDeMao')}). Assim o carro fica seguro mesmo se você tirar o pé do freio.`,
      detectar: (x) => x.ent.freioDeMao,
    },
    leitura('resumo', 'Resumo',
      'Muito bem! Para sair: embreagem no fundo, primeira, ponto, solta o freio de mão, acelera e solta a embreagem devagar. Para parar: embreagem no fundo, freio, neutro e freio de mão.',
      'frente'),
  ],
  resumo: () => 'Você saiu, trocou de marcha e parou. Repita algumas vezes até ficar natural, depois experimente a saída em rampa.',
};
