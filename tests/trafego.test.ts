import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MOBI } from '../src/sim/carConfig';
import { COMANDOS_NEUTROS } from '../src/sim/powertrain';
import { DT_FISICA, HZ_FISICA, iniciarRapier, Simulacao } from '../src/sim/simulation';
import { lerMapa } from '../src/world/parser';
import { criarMapaAutoescola } from '../src/world/autoescola';
import { separacaoOBB, Trafego, type OpcoesTrafego } from '../src/world/trafego';
import { corSemaforo } from '../src/exam/exam';

beforeAll(async () => {
  await iniciarRapier();
});

function novo(op: OpcoesTrafego = {}) {
  const sim = new Simulacao(lerMapa(criarMapaAutoescola()), MOBI);
  const trafego = new Trafego(sim, { visuais: false, ...op });
  return { sim, trafego };
}

/** Pose do carro do jogador no plano: centro do colisor, yaw e meias medidas. */
function poseJogador(sim: Simulacao) {
  const t = sim.carro.corpo.translation();
  const r = sim.carro.corpo.rotation();
  const yaw = Math.atan2(2 * (r.x * r.z + r.w * r.y), 1 - 2 * (r.x * r.x + r.y * r.y));
  const cb = sim.carro.cfg.carroceria;
  return {
    x: t.x + cb.centro[2] * Math.sin(yaw),
    z: t.z + cb.centro[2] * Math.cos(yaw),
    yaw,
    hw: cb.meiaLargura,
    hl: cb.meiaComprimento,
  };
}

describe('trânsito da autoescola', () => {
  it('carros andam sem bater entre si nem no carro parado', () => {
    const { sim, trafego } = novo();
    let anterior = trafego.estadoCarros();
    expect(anterior.length).toBe(6);
    const spawn = sim.mapa.spawn.posicao;
    // começam longe do jogador
    for (const c of anterior) expect(Math.hypot(c.x - spawn.x, c.z - spawn.z)).toBeGreaterThanOrEqual(25);

    let percorrido = 0;
    let menorFolga = Infinity;
    let menorFolgaJogador = Infinity;
    const eventos: string[] = [];
    for (let i = 0; i < 20 * HZ_FISICA; i++) {
      trafego.passo(DT_FISICA);
      sim.passo(COMANDOS_NEUTROS);
      const e = trafego.estadoCarros();
      const j = poseJogador(sim);
      for (let a = 0; a < e.length; a++) {
        percorrido += Math.hypot(e[a].x - anterior[a].x, e[a].z - anterior[a].z);
        expect(e[a].v).toBeLessThanOrEqual(30 / 3.6 + 1e-6);
        menorFolgaJogador = Math.min(menorFolgaJogador, separacaoOBB(e[a].x, e[a].z, e[a].yaw, e[a].meiaLargura, e[a].meioComprimento, j.x, j.z, j.yaw, j.hw, j.hl));
        for (let b = a + 1; b < e.length; b++) {
          menorFolga = Math.min(menorFolga, separacaoOBB(
            e[a].x, e[a].z, e[a].yaw, e[a].meiaLargura, e[a].meioComprimento,
            e[b].x, e[b].z, e[b].yaw, e[b].meiaLargura, e[b].meioComprimento,
          ));
        }
      }
      anterior = e;
      if (i % 50 === 0) eventos.push(...trafego.info().eventos);
    }
    eventos.push(...trafego.info().eventos);

    expect(percorrido).toBeGreaterThan(50);
    expect(menorFolga).toBeGreaterThan(1.0);
    expect(menorFolgaJogador).toBeGreaterThan(5);
    expect(eventos).toEqual([]);

    const info = trafego.info();
    expect(info.carros).toHaveLength(6);
    expect(info.pedestres).toHaveLength(6);
    expect(info.pedestres.every((p) => p.naFaixa === null || p.naFaixa.startsWith('FAIXA_PEDESTRE_'))).toBe(true);
  });

  it('o carro do trânsito para atrás do carro do jogador parado na faixa', () => {
    const { sim, trafego } = novo({ carros: 1, pedestres: 0 });
    // trecho reto do anel externo, descendo pela esquerda (longe de faixas e do PARE)
    let sJog = -1;
    for (let s = 0; s < 400; s += 1) {
      const p = trafego.pontoDaRota('anel_externo', s);
      if (p.x < -20 && p.z > 8 && p.z < 12) { sJog = s; break; }
    }
    expect(sJog).toBeGreaterThan(0);
    const pj = trafego.pontoDaRota('anel_externo', sJog);
    sim.carro.posicionar(new THREE.Vector3(pj.x, 0, pj.z), pj.yaw);
    trafego.colocarCarro(0, 'anel_externo', sJog - 35, 7);

    let menor = Infinity;
    for (let i = 0; i < 12 * HZ_FISICA; i++) {
      trafego.passo(DT_FISICA);
      sim.passo(COMANDOS_NEUTROS);
      const c = trafego.estadoCarros()[0];
      const j = poseJogador(sim);
      menor = Math.min(menor, separacaoOBB(c.x, c.z, c.yaw, c.meiaLargura, c.meioComprimento, j.x, j.z, j.yaw, j.hw, j.hl));
    }
    const c = trafego.estadoCarros()[0];
    const j = poseJogador(sim);
    const folga = separacaoOBB(c.x, c.z, c.yaw, c.meiaLargura, c.meioComprimento, j.x, j.z, j.yaw, j.hw, j.hl);
    expect(c.v).toBeLessThan(0.05);
    expect(menor).toBeGreaterThan(1.5);
    expect(folga).toBeLessThan(6);
    expect(trafego.info().eventos).toEqual([]);
  });

  it('bater no carro do trânsito gera um evento por contato; reiniciar volta ao começo', () => {
    const { sim, trafego } = novo({ carros: 1, pedestres: 0 });
    const inicio = trafego.estadoCarros()[0];
    for (let i = 0; i < 2 * HZ_FISICA; i++) { trafego.passo(DT_FISICA); sim.passo(COMANDOS_NEUTROS); }
    // joga o jogador em cima do carro do trânsito
    const c = trafego.estadoCarros()[0];
    sim.carro.posicionar(new THREE.Vector3(c.x + Math.sin(c.yaw) * 3.2, 0, c.z + Math.cos(c.yaw) * 3.2), c.yaw);
    const eventos: string[] = [];
    for (let i = 0; i < 20; i++) {
      trafego.passo(DT_FISICA);
      sim.passo(COMANDOS_NEUTROS);
      eventos.push(...trafego.info().eventos);
    }
    expect(eventos).toEqual(['colisao_carro']);

    sim.reposicionar();
    trafego.reiniciar();
    const r = trafego.estadoCarros()[0];
    expect(r.x).toBeCloseTo(inicio.x, 5);
    expect(r.z).toBeCloseTo(inicio.z, 5);
    expect(r.v).toBe(0);
  });

  it('pedestre atingido cai e gera evento', () => {
    const { sim, trafego } = novo({ carros: 0, pedestres: 1 });
    const p = trafego.info().pedestres[0].posicao.clone();
    sim.carro.posicionar(new THREE.Vector3(p.x, 0, p.z + 1.2), 0);
    const eventos: string[] = [];
    for (let i = 0; i < 10; i++) {
      trafego.passo(DT_FISICA);
      sim.passo(COMANDOS_NEUTROS);
      eventos.push(...trafego.info().eventos);
    }
    expect(eventos).toEqual(['atropelou_pedestre']);
  });

  it('liberar remove os corpos criados', () => {
    const { sim, trafego } = novo({ carros: 3, pedestres: 3 });
    const antes = sim.mundo.bodies.len();
    trafego.liberar();
    expect(sim.mundo.bodies.len()).toBe(antes - 6);
  });

  it('pedestres só entram na faixa com o semáforo vermelho para os carros', () => {
    const { sim, trafego } = novo();
    expect(trafego.faixasComSemaforo()).toEqual([
      { faixa: 'FAIXA_PEDESTRE_1', semaforos: ['2', '3'] },
      { faixa: 'FAIXA_PEDESTRE_2', semaforos: ['2', '3'] },
      { faixa: 'FAIXA_PEDESTRE_3', semaforos: ['1'] },
    ]);
    const sems = new Map(trafego.faixasComSemaforo().map((f) => [f.faixa, f.semaforos]));
    let antes = trafego.info().pedestres.map((p) => p.naFaixa);
    let entradas = 0;
    for (let i = 0; i < 80 * HZ_FISICA; i++) {
      trafego.passo(DT_FISICA);
      sim.passo(COMANDOS_NEUTROS);
      const agora = trafego.info().pedestres.map((p) => p.naFaixa);
      agora.forEach((f, k) => {
        if (!f || antes[k] === f) return;
        entradas++;
        for (const id of sems.get(f) ?? []) {
          const s = sim.mapa.semaforos.find((x) => x.id === id)!;
          expect(corSemaforo(s, sim.tempo), `${f} / semáforo ${id}`).toBe('vermelho');
        }
      });
      antes = agora;
    }
    expect(entradas).toBeGreaterThan(0);
    expect(trafego.travessias()).toBeGreaterThanOrEqual(1);
  });
});
