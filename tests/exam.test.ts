import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { KWID, MOBI } from '../src/sim/carConfig';
import { COMANDOS_NEUTROS } from '../src/sim/powertrain';
import { iniciarRapier, Simulacao } from '../src/sim/simulation';
import { lerMapa, Zona } from '../src/world/parser';
import { criarMapaTeste } from '../src/world/testMap';
import { amostrar, faixaPorId, projetar } from '../src/world/vias';
import type { InfoTrafego } from '../src/world/infoTrafego';
import { Cabine, Prova } from '../src/exam/exam';
import { Examinador } from '../src/exam/examinador';
import { LIMITE_PONTOS, PONTOS } from '../src/exam/regras';

beforeAll(async () => {
  await iniciarRapier();
});

const DT = 1 / 50;
const CMD = { ...COMANDOS_NEUTROS, freioDeMao: false };

/**
 * Bancada "teleporte": em vez de rodar a física, coloca o carro numa pose/velocidade
 * a cada passo e chama a prova — testa só a lógica do avaliador.
 */
async function bancada(mapaNome: 'teste' | 'autoescola') {
  let raiz: THREE.Object3D;
  if (mapaNome === 'teste') raiz = criarMapaTeste();
  else raiz = (await import('../src/world/autoescola')).criarMapaAutoescola();
  const mapa = lerMapa(raiz);
  const sim = new Simulacao(mapa, mapaNome === 'teste' ? KWID : MOBI);
  const prova = new Prova(sim);
  prova.iniciada = true;
  prova.tempoInicio = sim.tempo;
  const trafego: InfoTrafego = { pedestres: [], carros: [], eventos: [] };
  const colocar = (pos: THREE.Vector3, direcao: THREE.Vector3, vel: number) => {
    const yaw = Math.atan2(direcao.x, direcao.z);
    sim.carro.posicionar(pos, yaw);
    const d = direcao.clone().setY(0).normalize();
    sim.carro.corpo.setLinvel({ x: d.x * vel, y: 0, z: d.z * vel }, true);
  };
  const passo = (cabine: Cabine = { seta: null, cinto: true }) => {
    sim.tempo += DT;
    prova.atualizar(DT, CMD, cabine, [], trafego);
  };
  /** Anda ao longo de uma função s→pose por `seg` segundos. */
  const percorrer = (
    seg: number,
    pose: (t: number) => { pos: THREE.Vector3; dir: THREE.Vector3; vel: number },
    cabine?: Cabine,
  ) => {
    for (let i = 0; i < seg / DT; i++) {
      const p = pose(i * DT);
      colocar(p.pos, p.dir, p.vel);
      passo(cabine);
    }
  };
  const codigos = () => prova.faltas.map((f) => f.codigo).filter((c) => c !== 'sem_seta');
  return { mapa, sim, prova, trafego, colocar, passo, percorrer, codigos };
}

describe('regras (Res. CONTRAN 1.020/2025)', () => {
  it('pesos 1/2/4/6 e aprovação até 10 pontos', () => {
    expect(PONTOS).toMatchObject({ leve: 1, media: 2, grave: 4, gravissima: 6 });
    expect(LIMITE_PONTOS).toBe(10);
  });
});

describe('faltas novas da prova', () => {
  it('excesso de velocidade: 40 km/h por 3 s é grave (20–50 % acima), uma falta só', async () => {
    const b = await bancada('teste');
    const pos = b.mapa.spawn.posicao.clone();
    const dir = new THREE.Vector3(Math.sin(b.mapa.spawn.yaw), 0, Math.cos(b.mapa.spawn.yaw));
    b.percorrer(3, () => ({ pos, dir, vel: 40 / 3.6 }));
    const f = b.prova.faltas.filter((x) => x.codigo === 'excesso_velocidade');
    expect(f).toHaveLength(1);
    expect(f[0].gravidade).toBe('grave');
    expect(f[0].posicao.x).toBeCloseTo(pos.x, 1);
    expect(b.prova.trajetoria.length).toBeGreaterThanOrEqual(5);
  });

  it('excesso de velocidade: 33 km/h é média; 29 km/h não é falta', async () => {
    const b = await bancada('teste');
    const pos = b.mapa.spawn.posicao.clone();
    const dir = new THREE.Vector3(Math.sin(b.mapa.spawn.yaw), 0, Math.cos(b.mapa.spawn.yaw));
    b.percorrer(3, () => ({ pos, dir, vel: 29 / 3.6 }));
    expect(b.codigos()).not.toContain('excesso_velocidade');
    b.percorrer(3, () => ({ pos, dir, vel: 33 / 3.6 }));
    expect(b.prova.faltas.find((x) => x.codigo === 'excesso_velocidade')?.gravidade).toBe('media');
  });

  it('andar no sentido certo do anel não gera falta; na contramão gera (grave, mão dupla)', async () => {
    const b = await bancada('autoescola');
    const anel = faixaPorId('anel_interno');
    const s0 = 60;
    b.percorrer(4, (t) => {
      const a = amostrar(anel, s0 + 6 * t);
      return { pos: a.ponto, dir: a.direcao, vel: 6 };
    });
    expect(b.codigos()).toEqual([]);

    b.percorrer(3, (t) => {
      const a = amostrar(anel, s0 + 24 - 5 * t);
      return { pos: a.ponto, dir: a.direcao.clone().negate(), vel: 5 };
    });
    const c = b.codigos();
    expect(c.filter((x) => x === 'contramao')).toHaveLength(1);
    expect(b.prova.faltas.find((f) => f.codigo === 'contramao')!.gravidade).toBe('grave');
  });

  it('transpor a linha amarela do anel é falta (uma por episódio)', async () => {
    const b = await bancada('autoescola');
    const int = faixaPorId('anel_interno');
    const ext = faixaPorId('anel_externo');
    const pose = (s: number, desvio: number) => {
      const a = amostrar(int, s);
      const paraFora = projetar(ext, a.ponto).ponto.sub(a.ponto).setY(0).normalize();
      return { pos: a.ponto.clone().addScaledVector(paraFora, desvio), dir: a.direcao, vel: 6 };
    };
    b.percorrer(2, (t) => pose(60 + 6 * t, 0));
    expect(b.codigos()).toEqual([]);
    b.percorrer(2, (t) => pose(72 + 6 * t, 1.4));
    expect(b.codigos()).toEqual(['linha_divisoria']);
  });

  it('não dar preferência ao pedestre na faixa é gravíssima', async () => {
    const b = await bancada('autoescola');
    const faixa = b.mapa.zonas.find((z) => z.nome.toUpperCase() === 'FAIXA_PEDESTRE_1') as Zona;
    const oeste = new THREE.Vector3(-1, 0, 0);
    const z = faixa.centro.z + 2;
    const atravessar = () =>
      b.percorrer(3, (t) => ({ pos: new THREE.Vector3(faixa.centro.x + 7 - 5 * t, 0, z), dir: oeste, vel: 5 }));
    atravessar(); // sem pedestre
    expect(b.codigos()).not.toContain('preferencia_pedestre');
    b.trafego.pedestres.push({ posicao: faixa.centro.clone(), naFaixa: 'FAIXA_PEDESTRE_1' });
    atravessar();
    const f = b.prova.faltas.filter((x) => x.codigo === 'preferencia_pedestre');
    expect(f).toHaveLength(1);
    expect(f[0].gravidade).toBe('gravissima');
  });

  it('colisão informada pelo trânsito interrompe a prova (reprovado)', async () => {
    const b = await bancada('autoescola');
    const a = amostrar(faixaPorId('anel_interno'), 60);
    b.colocar(a.ponto, a.direcao, 5);
    b.passo();
    expect(b.prova.encerrada).toBe(false);
    b.trafego.eventos.push('colisao_carro');
    b.passo();
    expect(b.codigos()).toContain('colisao');
    expect(b.trafego.eventos).toHaveLength(0);
    expect(b.prova.eliminado).toBe(true);
    expect(b.prova.encerrada).toBe(true);
    expect(b.prova.aprovado).toBe(false);
  });

  it('freada brusca sem motivo é leve; com pedestre à frente, não', async () => {
    const b = await bancada('teste');
    const pos = b.mapa.spawn.posicao.clone();
    const dir = new THREE.Vector3(Math.sin(b.mapa.spawn.yaw), 0, Math.cos(b.mapa.spawn.yaw));
    const frear = () => {
      b.percorrer(1, () => ({ pos, dir, vel: 8 }));
      b.percorrer(1.5, (t) => ({ pos, dir, vel: Math.max(0, 8 - 9 * t) }));
    };
    frear();
    expect(b.codigos()).toEqual(['freada_brusca']);
    b.trafego.pedestres.push({ posicao: pos.clone().addScaledVector(dir, 10), naFaixa: null });
    frear();
    expect(b.codigos()).toEqual(['freada_brusca']);
  });

  it('virar da avenida para o anel sem seta é falta; com seta, não', async () => {
    for (const seta of [null, 'direita'] as const) {
      const b = await bancada('autoescola');
      const diag = faixaPorId('diagonal_3');
      const int = faixaPorId('anel_interno');
      const cab: Cabine = { seta, cinto: true };
      // sobe a avenida…
      b.percorrer(3, (t) => {
        const a = amostrar(diag, 8 + 6 * t);
        return { pos: a.ponto, dir: a.direcao, vel: 6 };
      }, cab);
      // …vira à direita no cruzamento de cima (rumo gira de noroeste para leste)…
      const fim = amostrar(diag, diag.comprimento);
      const r0 = Math.atan2(fim.direcao.x, fim.direcao.z);
      const r1 = Math.PI / 2;
      let giro = r1 - r0;
      while (giro > 0) giro -= 2 * Math.PI; // para a direita = rumo diminuindo
      b.percorrer(2, (t) => {
        const r = r0 + (giro * t) / 2;
        return { pos: fim.ponto.clone().add(new THREE.Vector3(2 * t, 0, -4 * t)), dir: new THREE.Vector3(Math.sin(r), 0, Math.cos(r)), vel: 5 };
      }, cab);
      // …e segue pelo anel interno, lado direito, no sentido certo
      const sLeste = int.acumulado[int.pontos.reduce((m, p, i) => (p.x > int.pontos[m].x ? i : m), 0)];
      b.percorrer(3, (t) => {
        const a = amostrar(int, sLeste - 10 + 6 * t);
        return { pos: a.ponto, dir: a.direcao, vel: 6 };
      }, cab);
      if (seta) expect(b.codigos()).toEqual([]);
      else expect(b.codigos()).toEqual(['conversao_sem_seta']);
    }
  });
});

describe('examinador', () => {
  it('avança pelas primeiras etapas quando o carro é teleportado pelo trajeto', async () => {
    const b = await bancada('autoescola');
    b.prova.iniciada = false;
    const ex = new Examinador(b.sim, b.prova, { voz: false });
    const ext = faixaPorId('anel_externo');
    const int = faixaPorId('anel_interno');
    const diag = faixaPorId('diagonal_2');
    const spawn = b.mapa.spawn.posicao;
    const rodar = (seg: number) => {
      for (let i = 0; i < seg / DT; i++) ex.atualizar(DT);
    };
    const naFaixa = (f: typeof ext, s: number) => {
      const a = amostrar(f, s);
      b.colocar(a.ponto, a.direcao, 6);
      rodar(0.2);
    };
    const atravessarZona = (nome: string) => {
      const z = b.mapa.zonas.find((x) => x.nome.toUpperCase() === nome)!;
      const local = new THREE.Matrix4().copy(z.inversa).invert();
      const eixo = new THREE.Vector3().setFromMatrixColumn(local, 2).setY(0).normalize();
      for (let d = -z.max.z - 2; d <= z.max.z + 3; d += 0.5) {
        b.colocar(z.centro.clone().setY(0).addScaledVector(eixo, d), eixo, 3);
        rodar(0.05);
      }
    };

    rodar(0.1);
    expect(ex.etapa).toBe(0);
    expect(ex.instrucao).toMatch(/cinto/);
    b.prova.iniciada = true;
    rodar(0.1);
    expect(ex.etapa).toBe(1);
    expect(ex.instrucao).toMatch(/direita/);

    naFaixa(ext, projetar(ext, spawn).s + 10);
    expect(ex.etapa).toBe(2);
    atravessarZona('ZONA_PARE_2');
    expect(ex.etapa).toBe(3);
    const baliza = b.mapa.zonas.find((z) => z.tipo === 'baliza')!;
    naFaixa(ext, projetar(ext, baliza.centro).s);
    expect(ex.etapa).toBe(4);
    naFaixa(diag, 10);
    expect(ex.etapa).toBe(5);
    atravessarZona('ZONA_PARE_1');
    expect(ex.etapa).toBe(6);
    expect(ex.instrucao).toMatch(/direita/);
    const sLeste = int.acumulado[int.pontos.reduce((m, p, i) => (p.x > int.pontos[m].x ? i : m), 0)];
    naFaixa(int, sLeste);
    expect(ex.etapa).toBe(7);

    // passa direto pela baliza: falta e continua na mesma etapa
    const sBaliza = projetar(int, baliza.centro).s;
    naFaixa(int, sBaliza - 20);
    expect(ex.instrucao).toMatch(/baliza/);
    for (let i = 0; i < 10; i++) naFaixa(int, sBaliza + 25);
    expect(b.prova.faltas.map((f) => f.codigo)).toContain('nao_seguiu_instrucao');
    expect(ex.etapa).toBe(7);
    expect(ex.totalEtapas).toBe(11);
  });

  it('errar a entrada da avenida manda dar mais uma volta (volta à etapa do PARE)', async () => {
    const b = await bancada('autoescola');
    const ex = new Examinador(b.sim, b.prova, { voz: false });
    const ext = faixaPorId('anel_externo');
    const diag = faixaPorId('diagonal_2');
    const rodar = (seg: number) => {
      for (let i = 0; i < seg / DT; i++) ex.atualizar(DT);
    };
    const naFaixa = (s: number) => {
      const a = amostrar(ext, s);
      b.colocar(a.ponto, a.direcao, 6);
      rodar(0.2);
    };
    rodar(0.1);
    naFaixa(projetar(ext, b.mapa.spawn.posicao).s + 10);
    expect(ex.etapa).toBe(2);
    // pula as etapas 2 e 3 (já testadas) teleportando direto para a 4
    (ex as unknown as { irPara(i: number): void }).irPara(4);
    const sEntrada = projetar(ext, diag.pontos[0]).s;
    for (let i = 0; i < 8; i++) naFaixa(sEntrada + 22);
    expect(b.prova.faltas.map((f) => f.codigo)).toContain('nao_seguiu_instrucao');
    expect(ex.etapa).toBe(2);
  });
});

describe('sem falsos positivos', () => {
  it('uma volta inteira em cada faixa, no sentido certo, não gera falta', async () => {
    for (const id of ['anel_interno', 'anel_externo', 'diagonal_1', 'diagonal_2', 'diagonal_3']) {
      const b = await bancada('autoescola');
      const f = faixaPorId(id);
      const v = 7;
      const seg = (f.comprimento - 1) / v;
      b.percorrer(seg, (t) => {
        const a = amostrar(f, 0.5 + v * t);
        return { pos: a.ponto, dir: a.direcao, vel: v };
      });
      // o percurso anda sem parar: passar direto pelos PARE é falta esperada aqui
      const c = b.codigos().filter((x) => x !== 'nao_parou_pare');
      expect([id, ...c]).toEqual([id]);
    }
  });
});
