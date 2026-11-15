import * as THREE from 'three';
import type { Simulacao } from '../../sim/simulation';
import { dentroDaZona, Obstaculo } from '../../world/parser';
import { amostrar, faixaPorId, projetar } from '../../world/vias';
import { paraPlanta, poseCarro, quadroZona, tocaObstaculo, yawMundo } from '../geo';
import { clamp01, DefLicao, Exec, leitura, Passo, segurar } from '../passo';
import type { Marcador } from '../tipos';
import { comoEngatar, engatada } from './comum';

/**
 * Lição 5 — Baliza com referências. A vaga é a ZONA_BALIZA (faixa interna do lado
 * esquerdo da planta, encostada no meio-fio, entre as 4 hastes BALIZA_n). O carro é
 * colocado parado ao lado, um pouco à frente da vaga, no sentido do trânsito.
 *
 * Referencial da lição ("quadro da vaga"):
 *   ao longo (s): no sentido do trânsito (positivo = à frente do centro da vaga);
 *   lateral (l): positivo = para o lado do meio-fio (onde fica a vaga).
 *
 * A técnica (duas curvas com o volante todo virado, raio mínimo do carro):
 *   1. ré reta até a traseira passar ~45 cm da baliza da frente (linha amarela no chão);
 *   2. volante todo para o lado da vaga, ré até o carro ficar a ~60°;
 *   3. volante todo para o outro lado, ré até o carro ficar reto — se a traseira chegar
 *      perto da baliza de trás antes disso: parar, 1ª, volante todo para o lado da vaga
 *      e ir para a frente até endireitar (correção; repete se preciso);
 *   4. acertar para a frente/para trás até ficar no meio da vaga, e parar.
 * Os números em BALIZA saíram de uma varredura com o "aluno" robô de tests/treino.test.ts.
 * A conclusão usa a mesma geometria da Prova: os 4 cantos dentro da zona, parado por 1,5 s.
 */

/** Referências da técnica (ajustadas rodando a física com um "aluno" robô em tests/treino.test.ts). */
export const BALIZA = {
  /** Afastamento lateral entre a lateral do carro e a linha das hastes, ao começar (m). */
  afastamento: 0.7,
  /** Quanto a traseira começa à frente da baliza da frente (m) — para dar a ré reta antes de virar. */
  folgaInicio: 1.5,
  /** Distância (m) do para-choque até a baliza de trás/da frente em que o aluno deve parar e corrigir. */
  folgaHaste: 0.35,
  /** Ponto de virar: para-choque traseiro esta distância à frente da baliza da frente (m; negativo = já passou dela). */
  pontoVirar: -0.45,
  /** Inclinação (graus) em que se vira o volante para o outro lado. */
  anguloDesvirar: 60,
};

export interface QuadroVaga {
  centro: THREE.Vector3;
  /** sentido do trânsito */
  u: THREE.Vector3;
  /** para o meio-fio */
  lado: THREE.Vector3;
  /** meia largura/comprimento entre as hastes */
  meiaLargura: number;
  meioComprimento: number;
  hastes: Obstaculo[];
  /** s da baliza da frente (as hastes "à frente" no sentido do trânsito) */
  sFrente: number;
  /** lado do meio-fio em relação ao carro: +1 direita, −1 esquerda */
  ladoVaga: 1 | -1;
  yaw: number;
}

const cache = new WeakMap<Simulacao, QuadroVaga | null>();

export function quadroVaga(sim: Simulacao): QuadroVaga | null {
  if (cache.has(sim)) return cache.get(sim)!;
  const z = sim.mapa.zonas.find((zz) => zz.tipo === 'baliza');
  let q: QuadroVaga | null = null;
  if (z) {
    const centro = quadroZona(z).centro.clone();
    const hastes = sim.mapa.obstaculos.filter((o) => o.tipo === 'baliza' && Math.hypot(o.x - centro.x, o.z - centro.z) < 6);
    // eixos da própria caixa da vaga; o sentido vem da faixa interna do anel ali perto
    const qz = quadroZona(z);
    const f = faixaPorId('anel_interno');
    const pr = projetar(f, centro);
    const dirFaixa = amostrar(f, pr.s).direcao;
    const u = qz.eixoZ.clone().multiplyScalar(Math.sign(qz.eixoZ.dot(dirFaixa)) || 1);
    // lado do meio-fio: o lado da vaga oposto à linha central da faixa
    const esquerdaU = new THREE.Vector3(u.z, 0, -u.x);
    const rel = centro.clone().sub(pr.ponto);
    const ladoVaga: 1 | -1 = rel.dot(esquerdaU) > 0 ? -1 : 1;
    const lado = ladoVaga === 1 ? esquerdaU.clone().negate() : esquerdaU.clone();
    const ss = hastes.map((h) => (h.x - centro.x) * u.x + (h.z - centro.z) * u.z);
    const ll = hastes.map((h) => (h.x - centro.x) * lado.x + (h.z - centro.z) * lado.z);
    q = {
      centro,
      u,
      lado,
      meiaLargura: ll.length ? (Math.max(...ll) - Math.min(...ll)) / 2 : 1.2,
      meioComprimento: ss.length ? (Math.max(...ss) - Math.min(...ss)) / 2 : 2.35,
      hastes,
      sFrente: ss.length ? Math.max(...ss) : 2.35,
      ladoVaga,
      yaw: yawMundo(u),
    };
  }
  cache.set(sim, q);
  return q;
}

/** Pose do carro de partida da baliza (px da planta + yaw). */
export function inicioBaliza(sim: Simulacao): { x: number; y: number; yaw: number } | null {
  const q = quadroVaga(sim);
  if (!q) return null;
  const cfg = sim.carro.cfg;
  const traseira = -(cfg.carroceria.meiaComprimento - cfg.carroceria.centro[2]); // s do para-choque traseiro (a partir do CG)
  const s = q.sFrente + BALIZA.folgaInicio - traseira;
  const l = -(q.meiaLargura + BALIZA.afastamento + cfg.carroceria.meiaLargura);
  const p = q.centro.clone().addScaledVector(q.u, s).addScaledVector(q.lado, l);
  const pp = paraPlanta(p);
  return { x: pp.x, y: pp.y, yaw: q.yaw };
}

export interface EstadoBaliza {
  /** s do para-choque traseiro */
  sTraseira: number;
  /** lateral do centro do carro */
  l: number;
  /** ângulo do carro em relação ao sentido da vaga (graus; positivo = traseira virada para o meio-fio) */
  angulo: number;
  dentro: boolean;
  tocou: boolean;
}

export function estadoBaliza(sim: Simulacao): EstadoBaliza | null {
  const q = quadroVaga(sim);
  const z = sim.mapa.zonas.find((zz) => zz.tipo === 'baliza');
  if (!q || !z) return null;
  const p = poseCarro(sim);
  const rel = (v: THREE.Vector3) => ({ s: (v.x - q.centro.x) * q.u.x + (v.z - q.centro.z) * q.u.z, l: (v.x - q.centro.x) * q.lado.x + (v.z - q.centro.z) * q.lado.z });
  // ângulo: frente do carro vs. u; positivo quando a frente aponta para fora (traseira para o meio-fio)
  const fl = p.frente.x * q.lado.x + p.frente.z * q.lado.z;
  const fu = p.frente.x * q.u.x + p.frente.z * q.u.z;
  const angulo = (-Math.atan2(fl, fu) * 180) / Math.PI;
  const _t = new THREE.Vector3();
  return {
    sTraseira: rel(p.traseira).s,
    l: rel(p.pos).l,
    angulo,
    dentro: p.cantos.every((c) => dentroDaZona(z, c, _t)),
    tocou: q.hastes.some((h) => tocaObstaculo(sim, h) || sim.derrubado(h)),
  };
}

const est = (x: Exec) => estadoBaliza(x.sim);

function marcadores(x: Exec, fase: 'alinhar' | 'virar' | 'desvirar' | 'acertar' | 'nenhuma'): Marcador[] {
  const q = quadroVaga(x.sim);
  if (!q) return [];
  const e = est(x);
  const out: Marcador[] = [
    {
      id: 'vaga', tipo: 'alvo', posicao: q.centro.clone().setY(0.03), yaw: q.yaw,
      largura: q.meiaLargura * 2, comprimento: q.meioComprimento * 2,
      cor: e?.dentro ? 0x3ddc84 : 0x4aa8ff, rotulo: 'Vaga', ativo: fase === 'acertar',
    },
    ...q.hastes.map((h, i): Marcador => ({
      id: `haste${i}`, tipo: 'poste', posicao: new THREE.Vector3(h.x, 0.03, h.z), yaw: 0, largura: 0.6, comprimento: 0.6,
      cor: 0xff8a00, ativo: fase === 'virar' || fase === 'desvirar',
    })),
  ];
  const cfg = x.sim.carro.cfg;
  const lCarro = -(q.meiaLargura + BALIZA.afastamento + cfg.carroceria.meiaLargura);
  if (fase === 'alinhar' || fase === 'nenhuma') {
    out.push({
      id: 'ponto_virar', tipo: 'linha',
      posicao: q.centro.clone().addScaledVector(q.u, q.sFrente + BALIZA.pontoVirar).addScaledVector(q.lado, lCarro).setY(0.03),
      yaw: q.yaw, largura: 2.2, comprimento: 0.25, cor: 0xffd400, rotulo: 'Traseira aqui: vire o volante', ativo: fase === 'alinhar',
    });
  }
  if (fase === 'virar' || fase === 'desvirar') {
    // seta indicando para onde a traseira vai (para dentro da vaga, em diagonal)
    const dir = q.u.clone().negate().add(q.lado).normalize();
    out.push({
      id: 'seta_vaga', tipo: 'seta',
      posicao: q.centro.clone().addScaledVector(q.u, q.sFrente - 0.3).addScaledVector(q.lado, -0.6).setY(0.03),
      yaw: yawMundo(dir), largura: 0.9, comprimento: 2.2, cor: 0xffd400, ativo: true,
    });
  }
  return out;
}

const tocouFalha = (x: Exec): string | null => {
  const e = est(x);
  if (e?.tocou) return 'Você encostou numa baliza. Na prova isso é falta. Vamos recomeçar do início, com calma: a ré bem devagar, controlando com a embreagem.';
  return null;
};

function passo(p: Passo): Passo {
  return { falhou: tocouFalha, seFalhar: 'posicionar', repetirDe: 'posicionar', ...p };
}

const devagar = 'Ré bem devagar: controle a velocidade com a embreagem no ponto e o pé perto do freio.';

export const LICAO_BALIZA: DefLicao = {
  id: 'baliza',
  titulo: 'Baliza com referências',
  descricao: 'Estacionar entre as balizas, de ré, usando referências: ponto de virar, volante todo para um lado, depois para o outro, e acertar no meio da vaga.',
  marcadores: (x) => marcadores(x, 'nenhuma'),
  passos: [
    {
      id: 'posicionar',
      titulo: 'Ao lado da vaga',
      foco: 'espelhoDir',
      semFesta: true,
      texto: 'O carro está parado ao lado da vaga, um pouco à frente dela, a meio metro das balizas. A vaga está à sua direita, marcada em azul no chão.',
      aoIniciar: (x) => {
        const p = inicioBaliza(x.sim);
        if (p) x.teleportar(p.x, p.y, p.yaw);
        x.sim.reporObstaculos();
      },
      detectar: (x) => x.t > 2.5 && x.sim.carro.velocidade() < 0.08,
      marcadores: (x) => marcadores(x, 'nenhuma'),
    },
    passo({
      id: 'ligar',
      titulo: 'Partida',
      foco: 'volante',
      texto: (x) => `Cinto (${x.nome('cinto')}), embreagem no fundo, neutro, e dê a partida (${x.nome('partida')}).`,
      detectar: (x) => x.trem.ligado && x.ent.cinto,
    }),
    leitura('referencias', 'As referências', 'Olhe o chão: a faixa amarela marca onde a traseira do carro deve estar para começar a virar. As balizas laranja são as hastes da vaga; não pode encostar nelas. O retângulo azul é a vaga: o carro tem de terminar inteiro dentro dele.', 'espelhoDir', {
      marcadores: (x) => marcadores(x, 'alinhar'),
    }),
    passo({
      id: 're',
      titulo: 'Engatar a ré',
      foco: 'cambio',
      requerMotor: true,
      texto: (x) => `Pise a embreagem e engate a ré: ${comoEngatar(x, -1)}. Solte o freio de mão (${x.nome('freioDeMao')}).`,
      detectar: (x) => engatada(x, -1) && !x.ent.freioDeMao,
      marcadores: (x) => marcadores(x, 'alinhar'),
    }),
    passo({
      id: 're_reta',
      semFesta: true,
      titulo: '1. Ré reta até a faixa amarela',
      foco: null,
      requerMotor: true,
      texto: (x) => `Volante reto. ${devagar} Olhe para trás (${x.nome('olharTras')}) e pelo espelho direito: pare quando a traseira chegar na faixa amarela, logo depois de passar a baliza da frente (uns 45 centímetros).`,
      dica: 'Se passar da faixa, não tem problema: siga para o próximo passo assim mesmo, só vai precisar acertar mais no fim.',
      detectar: (x) => {
        const e = est(x);
        return !!e && e.sTraseira <= (quadroVaga(x.sim)?.sFrente ?? 0) + BALIZA.pontoVirar + 0.15;
      },
      progresso: (x) => {
        const e = est(x);
        const q = quadroVaga(x.sim);
        if (!e || !q) return 0;
        return clamp01((q.sFrente + BALIZA.folgaInicio - e.sTraseira) / (BALIZA.folgaInicio - BALIZA.pontoVirar));
      },
      rotuloProgresso: 'Até a faixa',
      marcadores: (x) => marcadores(x, 'alinhar'),
    }),
    passo({
      id: 'virar',
      semFesta: true,
      titulo: '2. Volante todo para o lado da vaga',
      foco: null,
      requerMotor: true,
      texto: (x) => `Vire o volante todo para o lado da vaga (${quadroVaga(x.sim)?.ladoVaga === -1 ? 'esquerda' : 'direita'}) e continue a ré devagar, até o carro ficar bem inclinado, uns 60 graus — a traseira entrando na vaga. O medidor mostra a inclinação.`,
      dica: 'Gire o volante até o fim (batente). Se estiver rápido demais, pise a embreagem e freie um pouco.',
      detectar: (x) => (est(x)?.angulo ?? 0) >= BALIZA.anguloDesvirar,
      progresso: (x) => clamp01((est(x)?.angulo ?? 0) / BALIZA.anguloDesvirar),
      rotuloProgresso: 'Inclinação do carro',
      marcadores: (x) => marcadores(x, 'virar'),
    }),
    passo({
      id: 'desvirar',
      semFesta: true,
      titulo: '3. Volante todo para o outro lado',
      foco: null,
      requerMotor: true,
      texto: (x) => `Agora vire o volante todo para o outro lado (${quadroVaga(x.sim)?.ladoVaga === -1 ? 'direita' : 'esquerda'}) e continue a ré: a frente do carro vai entrar na vaga. Pare quando o carro ficar reto.`,
      dica: 'Olhe o espelho direito: o carro deve ficar paralelo ao meio-fio. Se a traseira chegar perto da baliza de trás, pare.',
      detectar: (x) => {
        const e = est(x);
        const q = quadroVaga(x.sim);
        if (!e || !q) return false;
        if (Math.abs(e.angulo) < 6) return true;
        if (e.sTraseira < -q.sFrente + BALIZA.folgaHaste) x.irPara('corrigir');
        return false;
      },
      progresso: (x) => clamp01(1 - Math.abs(est(x)?.angulo ?? BALIZA.anguloDesvirar) / BALIZA.anguloDesvirar),
      rotuloProgresso: 'Endireitando',
      marcadores: (x) => marcadores(x, 'desvirar'),
    }),
    passo({
      id: 'corrigir',
      semFesta: true,
      titulo: 'Correção: para a frente',
      foco: null,
      requerMotor: true,
      texto: (x) => `Pare! A traseira chegou perto da baliza de trás. Engate a primeira (${comoEngatar(x, 1)}), vire o volante todo para o lado da vaga (${quadroVaga(x.sim)?.ladoVaga === -1 ? 'esquerda' : 'direita'}) e vá para a frente devagar, até o carro ficar reto.`,
      dica: 'Corrigir é normal. Se a frente chegar perto da baliza da frente, pare e volte a dar ré com o volante para o outro lado.',
      aoIniciar: (x) => x.avisar('Pare! Hora de corrigir para a frente.', 'info'),
      detectar: (x) => {
        const e = est(x);
        const q = quadroVaga(x.sim);
        if (!e || !q) return false;
        if (Math.abs(e.angulo) < 5) return true;
        const comprimento = x.sim.carro.cfg.carroceria.meiaComprimento * 2;
        if (x.t > 1 && e.sTraseira + comprimento * Math.cos((e.angulo * Math.PI) / 180) > q.sFrente - BALIZA.folgaHaste) x.irPara('desvirar');
        return false;
      },
      progresso: (x) => clamp01(1 - Math.abs(est(x)?.angulo ?? BALIZA.anguloDesvirar) / BALIZA.anguloDesvirar),
      rotuloProgresso: 'Endireitando',
      marcadores: (x) => marcadores(x, 'desvirar'),
    }),
    passo({
      id: 'acertar',
      titulo: '4. Acertar e parar',
      foco: null,
      requerMotor: true,
      texto: (x) => `Endireite o volante e acerte o carro no meio da vaga, indo um pouco para a frente (${comoEngatar(x, 1)}) ou para trás, se precisar. Quando o retângulo ficar verde, pare e espere.`,
      dica: 'O carro tem de ficar inteiro dentro da vaga, sem encostar nas balizas. Pequenas correções são permitidas.',
      detectar: (x) => segurar(x, 'p', !!est(x)?.dentro && x.sim.carro.velocidade() < 0.05, 1.5),
      progresso: (x) => (est(x)?.dentro ? clamp01(0.5 + (x.mem.p ?? 0) / 3) : 0),
      rotuloProgresso: 'Dentro da vaga',
      marcadores: (x) => marcadores(x, 'acertar'),
      festa: 'Baliza feita! Muito bem!',
    }),
    passo({
      id: 'finalizar',
      titulo: 'Freio de mão e neutro',
      foco: 'freioDeMao',
      texto: (x) => `Puxe o freio de mão (${x.nome('freioDeMao')}) e coloque em neutro.`,
      detectar: (x) => x.ent.freioDeMao && engatada(x, 0),
      marcadores: (x) => marcadores(x, 'acertar'),
    }),
  ],
  resumo: () => 'Baliza concluída! Repita até ficar natural: na prova, o tempo é limitado e só são permitidas poucas correções.',
};
