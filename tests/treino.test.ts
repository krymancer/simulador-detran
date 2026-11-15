import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MOBI } from '../src/sim/carConfig';
import { Comandos } from '../src/sim/powertrain';
import { DT_FISICA, iniciarRapier, Simulacao } from '../src/sim/simulation';
import { lerMapa } from '../src/world/parser';
import { alturaTerreno, criarMapaAutoescola, px } from '../src/world/autoescola';
import type { AcaoBotao, EstadoEntrada } from '../src/input/input';
import { ContextoTreino, IdLicao, LICOES, Treino } from '../src/treino/treino';
import type { AlvoCamera } from '../src/treino/tipos';
import { BALIZA, estadoBaliza, inicioBaliza, quadroVaga } from '../src/treino/licoes/baliza';

const env = (k: string) => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[k];

beforeAll(async () => {
  await iniciarRapier();
});

/** O que o "aluno" (bot) está fazendo com os comandos. */
interface Maos {
  volante: number;
  acelerador: number;
  freio: number;
  embreagem: number;
  marcha: number;
  freioDeMao: boolean;
  partida: boolean;
  seta: 'esquerda' | 'direita' | null;
  cinto: boolean;
  farol: boolean;
  alerta: boolean;
  olhar: number;
  olharTras: boolean;
  /** botões apertados neste passo (bordas) */
  apertar: AcaoBotao[];
}

type Bot = (id: string, t: number, m: Maos, mem: Record<string, number>, h: Harness) => void;

interface Harness {
  sim: Simulacao;
  treino: Treino;
  falas: string[];
  focos: AlvoCamera[];
  ids: string[];
  mensagens: string[];
  kmh: () => number;
  rodar: (seg: number, bot: Bot, parar?: () => boolean) => void;
}

function montar(): Harness {
  const sim = new Simulacao(lerMapa(criarMapaAutoescola()), MOBI);
  const m: Maos = {
    volante: 0, acelerador: 0, freio: 0, embreagem: 0, marcha: 0, freioDeMao: true, partida: false,
    seta: null, cinto: false, farol: false, alerta: false, olhar: 0, olharTras: false, apertar: [],
  };
  let partidaAntes = false;
  let ent: EstadoEntrada = { ...m, partidaBorda: false, bordas: new Set(), temVolante: false };
  const falas: string[] = [];
  const focos: AlvoCamera[] = [];
  const ctx: ContextoTreino = {
    sim,
    entrada: () => ent,
    perfilControles: () => ({ dispositivo: 'teclado', nomeDe: (a) => `[${a}]` }),
    focarCamera: (a) => focos.push(a),
    teleportar: (x, y, yaw) => {
      const p = px(x, y);
      p.y = alturaTerreno(p.x, p.z);
      sim.carro.posicionar(p, yaw);
    },
    falar: (t) => falas.push(t),
  };
  const treino = new Treino(ctx);
  const ids: string[] = [];
  const mensagens: string[] = [];
  let bloqueiaPartida = false;
  const h: Harness = {
    sim, treino, falas, focos, ids, mensagens,
    kmh: () => sim.carro.velocidadeLongitudinal() * 3.6,
    rodar: (seg, bot, parar) => {
      let idAtual = '';
      let t0 = 0;
      let mem: Record<string, number> = {};
      const n = Math.round(seg / DT_FISICA);
      for (let i = 0; i < n; i++) {
        const info = treino.passoAtual;
        const id = info?.id ?? '';
        if (id !== idAtual) {
          idAtual = id;
          t0 = sim.tempo;
          mem = {};
          ids.push(id);
        }
        if (info?.mensagem && mensagens[mensagens.length - 1] !== info.mensagem.texto) mensagens.push(info.mensagem.texto);
        m.apertar = [];
        bot(id, sim.tempo - t0, m, mem, h);
        const bordas = new Set<AcaoBotao>(m.apertar);
        const partidaBorda = m.partida && !partidaAntes;
        partidaAntes = m.partida;
        if (partidaBorda) bordas.add('partida');
        ent = { ...m, partidaBorda, bordas, temVolante: false };
        // como main.ts: apertar a partida com o motor ligado desliga
        let desligar = false;
        if (partidaBorda && sim.carro.trem.ligado) {
          desligar = true;
          bloqueiaPartida = true;
        }
        if (!m.partida) bloqueiaPartida = false;
        const cmd: Comandos = {
          volante: m.volante, acelerador: m.acelerador, freio: m.freio, embreagem: m.embreagem,
          freioDeMao: m.freioDeMao, marcha: m.marcha, partida: m.partida && !bloqueiaPartida, desligar,
        };
        sim.passo(cmd);
        sim.carro.trem.eventos.length = 0;
        treino.atualizar(DT_FISICA);
        if (treino.concluida || parar?.()) break;
      }
    },
  };
  return h;
}

const iniciar = (h: Harness, id: IdLicao) => h.treino.iniciar(id);

/** "Aluno" robô da baliza: segue as instruções de cada passo, controlando a ré pela embreagem. */
export function botBaliza(h: Harness, log = false): Bot {
  const q = quadroVaga(h.sim)!;
  let ultimo = 0;
  return (id, _t, m, mem) => {
    const trem = h.sim.carro.trem;
    const v = h.sim.carro.velocidadeLongitudinal();
    const e = estadoBaliza(h.sim)!;
    const creep = (alvo: number) => {
      const err = Math.abs(v) - alvo;
      m.embreagem = Math.min(1, Math.max(0.3, m.embreagem + (err > 0 ? 0.8 : -0.35) * DT_FISICA));
      m.freio = Math.abs(v) > alvo + 0.3 ? 0.3 : 0;
    };
    if (log && h.sim.tempo - ultimo > 0.5) {
      ultimo = h.sim.tempo;
      console.log(id, 's', e.sTraseira.toFixed(2), 'l', e.l.toFixed(2), 'ang', e.angulo.toFixed(1), 'v', v.toFixed(2), e.dentro, e.tocou);
    }
    switch (id) {
      case 'ligar': m.cinto = true; m.embreagem = 1; m.partida = !trem.ligado; break;
      case 'referencias': h.treino.continuar(); break;
      case 're': m.partida = false; m.embreagem = 1; m.marcha = -1; m.freioDeMao = false; break;
      case 're_reta': m.volante = 0; creep(0.5); break;
      case 'virar': m.marcha = -1; m.volante = q.ladoVaga; creep(0.4); break;
      case 'desvirar': m.marcha = -1; m.volante = -q.ladoVaga; creep(0.4); break;
      case 'corrigir':
        // para, 1ª, volante para o lado da vaga, para a frente
        if (!mem.c) { m.embreagem = 1; m.freio = 0.6; if (Math.abs(v) < 0.02) mem.c = 1; break; }
        m.marcha = 1; m.volante = q.ladoVaga; creep(0.35);
        break;
      case 'acertar': {
        m.volante = 0;
        const meio = h.sim.carro.cfg.carroceria.meiaComprimento;
        const err = e.sTraseira + meio; // centro da carroceria em relação ao centro da vaga
        if (!mem.fase) mem.fase = 1;
        if (mem.fase === 1) {
          // para, escolhe o sentido
          m.embreagem = 1; m.freio = 0.6;
          if (Math.abs(v) < 0.02) mem.fase = Math.abs(err) < 0.2 ? 3 : 2;
        } else if (mem.fase === 2) {
          m.marcha = err < 0 ? 1 : -1;
          m.freio = 0;
          creep(0.3);
          if (Math.abs(err) < 0.12) mem.fase = 1;
        } else { m.embreagem = 1; m.freio = 0.6; }
        break;
      }
      case 'finalizar': m.freioDeMao = true; m.marcha = 0; break;
    }
  };
}

describe('treino guiado', () => {
  it('lista as cinco lições com passos', () => {
    expect(LICOES.map((l) => l.id)).toEqual(['conhecer_carro', 'sair_trocar_parar', 'placas', 'rampa', 'baliza']);
    for (const l of LICOES) expect(l.passos).toBeGreaterThan(3);
  });

  it('lição 1: avança com os comandos certos', () => {
    const h = montar();
    iniciar(h, 'conhecer_carro');
    expect(h.treino.ativa).toBe('conhecer_carro');
    const bot: Bot = (id, t, m) => {
      switch (id) {
        case 'boas_vindas': case 'cambio_intro': case 'luzes_espia': case 'espelho_centro': case 'telas':
          if (t > 0.5) h.treino.continuar();
          break;
        case 'cinto': m.cinto = true; break;
        case 'volante': m.volante = t < 0.5 ? -1 : t < 1 ? 1 : 0; break;
        case 'embreagem': m.embreagem = t < 0.5 ? 1 : 0; break;
        case 'freio': m.freio = t < 0.5 ? 1 : 0; break;
        case 'acelerador': m.acelerador = t < 0.5 ? 1 : 0; break;
        case 'marchas':
          m.embreagem = 1;
          m.marcha = t < 0.4 ? 1 : t < 0.8 ? 2 : t < 1.2 ? 3 : -1;
          break;
        case 'neutro': m.marcha = 0; m.embreagem = 0; break;
        case 'freio_de_mao': m.freioDeMao = t > 0.5; break;
        case 'partida': m.embreagem = 1; m.partida = !h.sim.carro.trem.ligado; break;
        case 'painel': m.partida = false; m.embreagem = 0; m.acelerador = 0.6; break;
        case 'setas': m.acelerador = 0; m.seta = t < 0.3 ? 'esquerda' : t < 0.6 ? 'direita' : null; break;
        case 'farol': m.farol = t < 0.5; break;
        case 'alerta': m.alerta = t < 0.5; break;
        case 'espelho_esq': m.olhar = -1; break;
        case 'espelho_dir': m.olhar = 1; break;
        case 'olhar_tras': m.olhar = 0; m.olharTras = true; break;
        case 'camera':
          m.olharTras = false;
          if ([0.1, 0.3, 0.5].some((x) => Math.abs(t - x) < DT_FISICA / 2)) m.apertar.push('camera');
          break;
        case 'desligar': m.partida = t < 0.05; break;
      }
    };
    h.rodar(120, bot);
    console.log('lição 1:', h.ids.join(' → '));
    expect(h.treino.concluida).toBe(true);
    for (const id of ['cinto', 'volante', 'embreagem', 'freio', 'acelerador', 'marchas', 'neutro', 'freio_de_mao', 'partida', 'painel', 'setas', 'farol', 'alerta', 'espelho_esq', 'espelho_dir', 'olhar_tras', 'camera', 'desligar']) {
      expect(h.ids).toContain(id);
    }
    expect(h.focos).toEqual(expect.arrayContaining(['volante', 'pedais', 'cambio', 'freioDeMao', 'painel', 'espelhoCentro']));
    expect(h.mensagens.some((s) => /Muito bem|Isso|Ótimo|Perfeito|Mandou bem|Excelente/.test(s))).toBe(true);
    expect(h.sim.carro.trem.ligado).toBe(false);
  });

  it('lição 1: não avança sem o comando (e mostra a dica depois de ~15 s)', () => {
    const h = montar();
    iniciar(h, 'conhecer_carro');
    h.treino.continuar(); // pula a leitura
    expect(h.treino.passoAtual?.id).toBe('cinto');
    h.rodar(16, () => {});
    expect(h.treino.passoAtual?.id).toBe('cinto');
    expect(h.treino.passoAtual?.dica).toBeTruthy();
    h.treino.pular();
    expect(h.treino.passoAtual?.id).toBe('volante');
  });

  it('lição 2: partida, 1ª, ponto, sair, 2ª, reduzir e parar sem deixar o motor morrer', () => {
    const h = montar();
    iniciar(h, 'sair_trocar_parar');
    let apagou = 0;
    let ligadoAntes = false;
    const bot: Bot = (id, t, m, mem) => {
      const trem = h.sim.carro.trem;
      if (ligadoAntes && !trem.ligado && !m.partida) apagou++;
      ligadoAntes = trem.ligado;
      switch (id) {
        case 'cinto': m.cinto = true; break;
        case 'embreagem_neutro': m.embreagem = 1; m.marcha = 0; break;
        case 'partida': m.partida = !trem.ligado; break;
        case 'primeira': m.partida = false; m.marcha = 1; break;
        case 'ponto':
          // solta devagar até sentir o ponto e segura
          if (Math.abs(trem.torqueEmbreagem) < 9) m.embreagem = Math.max(0.5, m.embreagem - 0.1 * DT_FISICA);
          break;
        case 'soltar_freio_mao': m.freioDeMao = false; break;
        case 'sair':
          m.acelerador = 0.22;
          m.embreagem = Math.max(0, m.embreagem - 0.25 * DT_FISICA);
          break;
        case 'acelerar_1': m.embreagem = 0; m.acelerador = 0.4; break;
        case 'segunda':
          if (t < 0.4) { m.acelerador = 0; m.embreagem = 1; }
          else if (t < 0.7) m.marcha = 2;
          else { m.embreagem = Math.max(0, m.embreagem - 1.2 * DT_FISICA); m.acelerador = m.embreagem < 0.4 ? 0.3 : 0.1; }
          break;
        case 'manter_2': m.embreagem = 0; m.acelerador = h.kmh() < 20 ? 0.35 : 0.1; break;
        case 'reduzir':
          m.acelerador = 0;
          if (!mem.f && h.kmh() > 11) m.freio = 0.25;
          else if (!mem.f) { mem.f = t; m.freio = 0; }
          else if (t - mem.f < 0.3) m.embreagem = 1;
          else if (t - mem.f < 0.6) m.marcha = 1;
          else m.embreagem = Math.max(0, m.embreagem - 0.8 * DT_FISICA);
          break;
        case 'parar': m.embreagem = 1; m.freio = 0.4; break;
        case 'neutro': m.marcha = 0; break;
        case 'freio_mao': m.freioDeMao = true; m.freio = 0; break;
        case 'resumo': h.treino.continuar(); break;
      }
    };
    h.rodar(120, bot);
    console.log('lição 2:', h.ids.join(' → '), '| motor apagou', apagou, 'vezes');
    expect(h.treino.concluida).toBe(true);
    expect(apagou).toBe(0);
    for (const id of ['partida', 'primeira', 'ponto', 'soltar_freio_mao', 'sair', 'acelerar_1', 'segunda', 'manter_2', 'reduzir', 'parar', 'neutro', 'freio_mao']) {
      expect(h.ids).toContain(id);
    }
    expect(h.ids).not.toContain('motor_apagou');
  });

  it('lição 2: soltar a embreagem de uma vez apaga o motor, explica e pede nova partida', () => {
    const h = montar();
    iniciar(h, 'sair_trocar_parar');
    const bot: Bot = (id, _t, m) => {
      const trem = h.sim.carro.trem;
      switch (id) {
        case 'cinto': m.cinto = true; break;
        case 'embreagem_neutro': m.embreagem = 1; m.marcha = 0; break;
        case 'partida': m.partida = !trem.ligado; break;
        case 'primeira': m.partida = false; m.marcha = 1; break;
        case 'ponto': m.embreagem = 0; break; // solta tudo de uma vez, com freio de mão
        case 'motor_apagou': m.embreagem = 1; m.marcha = 0; m.partida = !trem.ligado; break;
      }
    };
    h.rodar(20, bot, () => h.ids.includes('motor_apagou') && h.sim.carro.trem.ligado && h.treino.passoAtual?.id !== 'motor_apagou');
    expect(h.ids).toContain('motor_apagou');
    expect(h.falas.some((f) => /apagou/i.test(f))).toBe(true);
    // depois de religar, volta para engatar a 1ª
    expect(h.treino.passoAtual?.id).toBe('primeira');
  });

  /** Bot da rampa: técnica com freio de mão (ou de pé). */
  const botRampa: Bot = (id, t, m, mem, h) => {
    const trem = h.sim.carro.trem;
    const pe = id.startsWith('pe_');
    const fase = id.replace(/^(r\d|pe)_/, '');
    if (id === 'intro' || id === 'pe_intro') { h.treino.continuar(); return; }
    m.cinto = true;
    switch (fase) {
      case 'posicionar':
        m.acelerador = 0; m.embreagem = 1; m.marcha = 0; m.partida = false;
        if (pe) { m.freio = 0.7; m.freioDeMao = false; } else { m.freioDeMao = true; m.freio = 0; }
        break;
      case 'ligar': m.embreagem = 1; m.marcha = 0; m.partida = !trem.ligado; break;
      case 'primeira': m.partida = false; m.marcha = 1; break;
      case 'ponto':
        if (!pe) m.acelerador = 0.3;
        if (Math.abs(trem.torqueEmbreagem) < 20) m.embreagem = Math.max(0.3, m.embreagem - 0.15 * DT_FISICA);
        break;
      case 'sair':
        if (!mem.ini) mem.ini = 1;
        m.freioDeMao = false;
        m.freio = 0;
        m.acelerador = 0.45;
        m.embreagem = Math.max(0, m.embreagem - 0.3 * DT_FISICA);
        void t;
        break;
    }
  };

  it('lição 4: três saídas em rampa + freio de pé, sem recuar', () => {
    const h = montar();
    iniciar(h, 'rampa');
    let recuoMax = 0;
    let ancora: number | null = null;
    h.rodar(200, (id, t, m, mem, hh) => {
      botRampa(id, t, m, mem, hh);
      if (id.endsWith('_sair')) {
        const z = hh.sim.carro.corpo.translation().z; // subindo para o norte = −Z
        if (ancora === null) ancora = z;
        recuoMax = Math.max(recuoMax, z - ancora);
      } else ancora = null;
    });
    console.log('lição 4:', h.ids.join(' → '), '| recuo máx', recuoMax.toFixed(3), 'm');
    expect(h.treino.concluida).toBe(true);
    expect(h.ids.filter((i) => i.endsWith('_falhou'))).toHaveLength(0);
    expect(h.ids).toEqual(expect.arrayContaining(['r1_sair', 'r2_sair', 'r3_sair', 'pe_sair']));
    expect(recuoMax).toBeLessThan(0.3);
  });

  it('lição 4: soltar o freio de mão sem o ponto deixa o carro voltar → repete a tentativa', () => {
    const h = montar();
    iniciar(h, 'rampa');
    h.rodar(60, (id, t, m, mem, hh) => {
      if (id === 'r1_sair') {
        // erro clássico: solta o freio de mão com a embreagem pisada
        m.freioDeMao = false;
        m.embreagem = 1;
        m.acelerador = 0;
        return;
      }
      botRampa(id, t, m, mem, hh);
    }, () => h.ids.filter((i) => i === 'r1_posicionar').length >= 2);
    console.log('lição 4 (recuo):', h.ids.join(' → '));
    expect(h.ids).toContain('r1_sair_falhou');
    expect(h.mensagens.some((s) => /voltou \d+ centímetros/.test(s))).toBe(true);
    expect(h.treino.passoAtual?.id).toBe('r1_posicionar');
  });

  it('lição 3: placas — perguntas respondidas com as teclas 1–3', () => {
    const h = montar();
    iniciar(h, 'placas');
    let respondidas = 0;
    h.rodar(400, (_id, t, m) => {
      const info = h.treino.passoAtual;
      if (info?.tipo === 'leitura' && t > 1.5) h.treino.continuar();
      if (info?.tipo === 'quiz' && info.quiz?.escolhida === null && t > 0.3) {
        // responde sempre a 2ª opção pelo "câmbio"
        m.apertar.push('marcha2');
        respondidas++;
      }
      if (info?.tipo === 'quiz' && info.quiz?.escolhida !== null && t > 0.5) h.treino.continuar();
    });
    expect(h.treino.concluida).toBe(true);
    expect(respondidas).toBe(12);
    expect(h.treino.passoAtual?.texto).toMatch(/Você acertou \d+ de 12/);
  });

  it('lição 5: carro começa ao lado da vaga, sem tocar; dentro da vaga + parado conclui', () => {
    const h = montar();
    const q = quadroVaga(h.sim)!;
    expect(q).toBeTruthy();
    expect(q.hastes).toHaveLength(4);
    const ini = inicioBaliza(h.sim)!;
    iniciar(h, 'baliza');
    h.rodar(3, () => {});
    const e = estadoBaliza(h.sim)!;
    expect(e.dentro).toBe(false);
    expect(e.tocou).toBe(false);
    expect(Math.abs(e.angulo)).toBeLessThan(3);
    expect(e.l).toBeLessThan(-q.meiaLargura); // fora da vaga, do lado da rua
    // coloca o carro dentro da vaga e confere a detecção do passo final
    const centro = h.sim.carro.cfg.carroceria.centro[2];
    const p = q.centro.clone().addScaledVector(q.u, centro); // centro da carroceria no centro da vaga
    // sem motor, um passo de manobra pede a partida antes (e volta para ele depois)
    expect(h.treino.passoAtual?.id).toBe('ligar');
    h.treino.pular(); // → referências
    h.treino.pular(); // → ré, que exige o motor ligado
    expect(h.treino.passoAtual?.id).toBe('motor_apagou');
    h.rodar(4, (_id, _t, m) => { m.embreagem = 1; m.partida = !h.sim.carro.trem.ligado; m.freio = 1; });
    expect(h.sim.carro.trem.ligado).toBe(true);
    expect(h.treino.passoAtual?.id).toBe('re');
    // leva o carro (ligado) para dentro da vaga e pula até "acertar"
    h.sim.carro.corpo.setTranslation({ x: p.x, y: h.sim.carro.cfg.alturaCG + 0.02, z: p.z }, true);
    h.sim.carro.corpo.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ini.yaw), true);
    let pulos = 0;
    while (h.treino.passoAtual?.id !== 'acertar' && pulos++ < 10) h.treino.pular();
    h.rodar(6, (_id, _t, m) => { m.partida = false; m.embreagem = 1; m.freio = 1; });
    expect(h.ids).toContain('acertar');
    expect(estadoBaliza(h.sim)!.dentro).toBe(true);
    expect(h.ids).toContain('finalizar');
  });

  it('lição 5: seguindo as referências, a baliza fica pronta', () => {
    const h = montar();
    iniciar(h, 'baliza');
    h.rodar(120, botBaliza(h, !!env('LOG_BALIZA')));
    console.log('lição 5:', h.ids.join(' → '), JSON.stringify(BALIZA));
    expect(h.ids.filter((i) => i.endsWith('_falhou'))).toHaveLength(0);
    expect(h.treino.concluida).toBe(true);
  });

  it.skipIf(!env('VARRER_BALIZA'))('(ajuste) varre as referências da baliza', () => {
    const orig = { ...BALIZA };
    const q0 = quadroVaga(montar().sim)!;
    console.log('vaga', q0.meiaLargura.toFixed(2), q0.meioComprimento.toFixed(2), q0.sFrente.toFixed(2), q0.ladoVaga);
    for (const af of [0.5, 0.7, 0.9]) for (const pv of [-0.9, -0.6, -0.45, -0.3, 0]) for (const ang of [45, 50, 55, 60]) {
      Object.assign(BALIZA, { afastamento: af, pontoVirar: pv, anguloDesvirar: ang });
      const h = montar();
      iniciar(h, 'baliza');
      h.rodar(90, botBaliza(h), () => h.ids.some((i) => i.endsWith('_falhou')));
      const e = estadoBaliza(h.sim)!;
      console.log(`af ${af} pv ${pv} ang ${ang}:`, h.treino.concluida ? 'OK' : 'falhou', h.ids[h.ids.length - 1], 's', e.sTraseira.toFixed(2), 'l', e.l.toFixed(2), 'a', e.angulo.toFixed(1));
    }
    Object.assign(BALIZA, orig);
  }, 120_000);
});
