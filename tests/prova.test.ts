import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { KWID, MOBI } from '../src/sim/carConfig';
import { Comandos, COMANDOS_NEUTROS } from '../src/sim/powertrain';
import { iniciarRapier, Simulacao, HZ_FISICA, DT_FISICA } from '../src/sim/simulation';
import { lerMapa } from '../src/world/parser';
import { criarMapaTeste } from '../src/world/testMap';
import { Cabine, Prova } from '../src/exam/exam';

beforeAll(async () => {
  await iniciarRapier();
});

function novo() {
  const mapa = lerMapa(criarMapaTeste());
  const sim = new Simulacao(mapa, KWID);
  const prova = new Prova(sim);
  const rodar = (seg: number, cmd: (t: number) => Partial<Comandos>, cabine: Cabine = { seta: null, cinto: true }) => {
    const t0 = sim.tempo;
    for (let i = 0; i < seg * HZ_FISICA; i++) {
      const c = { ...COMANDOS_NEUTROS, ...cmd(sim.tempo - t0) };
      sim.passo(c);
      prova.atualizar(DT_FISICA, c, cabine, sim.carro.trem.eventos.splice(0));
    }
  };
  return { mapa, sim, prova, rodar };
}

function pedalSuave(t: number): number {
  if (t < 0.5) return 1 - 0.7 * t;
  if (t < 4) return 0.65 - (0.35 * (t - 0.5)) / 3.5;
  return Math.max(0, 0.3 - (t - 4) * 0.4);
}

describe('mapa de teste + prova', () => {
  it('o parser encontra tudo pelas convenções de nome', () => {
    const { mapa } = novo();
    const tipos = mapa.zonas.map((z) => z.tipo).sort();
    expect(tipos).toEqual(['baliza', 'faixa_pedestre', 'linha_parada', 'rampa']);
    expect(mapa.obstaculos.filter((o) => o.tipo === 'baliza')).toHaveLength(4);
    expect(mapa.obstaculos.filter((o) => o.tipo === 'cone')).toHaveLength(2);
    expect(mapa.semaforos.map((s) => s.id)).toEqual(['1']);
    expect(mapa.colisores.some((c) => c.tipo === 'calcada')).toBe(true);
    // spawn aponta para +X
    expect(Math.abs(mapa.spawn.yaw - Math.PI / 2)).toBeLessThan(1e-6);
  });

  it('o carro nasce no chão, fora da calçada, e fica parado', () => {
    const { sim, rodar } = novo();
    rodar(2, () => ({}));
    const t = sim.carro.corpo.translation();
    expect(Math.abs(t.y - KWID.alturaCG)).toBeLessThan(0.05);
    expect(sim.carro.rodas.every((r) => r.noChao && sim.tipoColisor.get(r.colisorChao!) !== 'calcada')).toBe(true);
    expect(sim.carro.velocidade()).toBeLessThan(0.05);
  });

  it('sair sem cinto, sem seta e com freio de mão gera as faltas certas', () => {
    const { prova, rodar } = novo();
    rodar(1, () => ({ partida: true, embreagem: 1 }), { seta: null, cinto: false });
    expect(prova.iniciada).toBe(true);
    // Sai arrastando o freio de mão (com bastante acelerador, senão o motor morre).
    rodar(8, (t) => ({ marcha: 1, embreagem: pedalSuave(t), acelerador: 0.6, freioDeMao: true }), { seta: null, cinto: false });
    const codigos = prova.faltas.map((f) => f.codigo);
    console.log('faltas:', codigos.join(', '));
    expect(codigos).toContain('sem_cinto');
    expect(codigos).toContain('sem_seta');
    expect(codigos).toContain('freio_de_mao');
    expect(codigos).not.toContain('motor_apagou');
  });

  it('saída correta (cinto + seta + freio de mão solto) não gera falta', () => {
    const { prova, rodar } = novo();
    const cab: Cabine = { seta: 'esquerda', cinto: true };
    rodar(1, () => ({ partida: true, embreagem: 1 }), cab);
    rodar(1, () => ({ embreagem: 1 }), cab);
    rodar(7, (t) => ({ marcha: 1, embreagem: pedalSuave(t), acelerador: 0.25, freioDeMao: t < 2, volante: t > 3 && t < 4 ? -0.15 : 0 }), cab);
    console.log('faltas:', prova.faltas.map((f) => f.codigo).join(', ') || '(nenhuma)');
    expect(prova.faltas).toHaveLength(0);
  });

  it('deixar o motor apagar é falta', () => {
    const { prova, rodar } = novo();
    rodar(1, () => ({ partida: true, embreagem: 1 }));
    rodar(1, () => ({ embreagem: 1, marcha: 1 }));
    rodar(2, () => ({ embreagem: 0, marcha: 1, freioDeMao: false }));
    expect(prova.faltas.map((f) => f.codigo)).toContain('motor_apagou');
    expect(prova.aprovado).toBe(true); // média: 2 pontos, ainda aprovado
  });
});

describe('mapa da autoescola (planta)', () => {
  it('gera pista, calçadas, baliza, faixas, PARE e spawn', async () => {
    const { criarMapaAutoescola } = await import('../src/world/autoescola');
    const mapa = lerMapa(criarMapaAutoescola());
    const tipos = mapa.zonas.map((z) => z.tipo).sort();
    expect(tipos).toEqual(['baliza', 'faixa_pedestre', 'faixa_pedestre', 'faixa_pedestre', 'pare', 'pare']);
    expect(mapa.obstaculos.filter((o) => o.tipo === 'baliza')).toHaveLength(4);
    expect(mapa.colisores.some((c) => c.tipo === 'calcada')).toBe(true);
    const sim = new Simulacao(mapa, MOBI);
    for (let i = 0; i < 2 * HZ_FISICA; i++) sim.passo(COMANDOS_NEUTROS);
    const t = sim.carro.corpo.translation();
    // nasce no asfalto do estacionamento, parado, sem tocar calçada
    expect(Math.abs(t.y - MOBI.alturaCG)).toBeLessThan(0.05);
    expect(sim.carro.rodas.every((r) => r.noChao && sim.tipoColisor.get(r.colisorChao!) === 'chao')).toBe(true);
    expect(sim.carro.velocidade()).toBeLessThan(0.05);
  });

  it('bater numa baliza derruba e é eliminatória', async () => {
    const { criarMapaAutoescola } = await import('../src/world/autoescola');
    const mapa = lerMapa(criarMapaAutoescola());
    const baliza = mapa.obstaculos.find((o) => o.tipo === 'baliza')!;
    // põe o carro 6 m antes da baliza, apontando para ela, andando a 15 km/h
    mapa.spawn = { posicao: new THREE.Vector3(baliza.x, 0, baliza.z + 6), yaw: Math.PI };
    const sim = new Simulacao(mapa, MOBI);
    const prova = new Prova(sim);
    prova.iniciada = true;
    sim.carro.corpo.setLinvel({ x: 0, y: 0, z: -4.2 }, true);
    sim.carro.trem.omegaRoda.fill(4.2 / MOBI.roda.raio);
    for (let i = 0; i < 3 * HZ_FISICA; i++) {
      const c = { ...COMANDOS_NEUTROS, freioDeMao: false };
      sim.passo(c);
      prova.atualizar(DT_FISICA, c, { seta: null, cinto: true }, sim.carro.trem.eventos.splice(0));
    }
    const codigos = prova.faltas.map((f) => f.codigo);
    console.log('baliza:', codigos.join(', '), 'pos', baliza.x.toFixed(2), baliza.z.toFixed(2));
    expect(codigos).toContain('tocou_baliza');
    expect(codigos).toContain('derrubou_baliza');
    expect(prova.aprovado).toBe(false);
  });
});
