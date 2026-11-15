import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { KWID, MOBI } from '../src/sim/carConfig';
import { COMANDOS_NEUTROS } from '../src/sim/powertrain';
import { iniciarRapier, Simulacao } from '../src/sim/simulation';
import { lerMapa, Zona } from '../src/world/parser';
import { criarMapaMinimo } from './mapaMinimo';
import { amostrar, faixaPorId, projetar } from '../src/world/vias';
import { px } from '../src/world/autoescola';
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
  if (mapaNome === 'teste') raiz = criarMapaMinimo();
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

  it('linha amarela medida pela tinta: na curva de cima à direita, só o pneu passando da tinta conta; tracejado pode', async () => {
    const int = faixaPorId('anel_interno');
    const ext = faixaPorId('anel_externo');
    const percurso = (b: Awaited<ReturnType<typeof bancada>>, s0: number, desvio: number, comp = 15) => {
      b.percorrer(2.5, (t) => {
        const a = amostrar(int, s0 + comp * (t / 2.5));
        const paraFora = projetar(ext, a.ponto).ponto.sub(a.ponto).setY(0).normalize();
        return { pos: a.ponto.clone().addScaledVector(paraFora, desvio), dir: a.direcao, vel: 6 };
      });
    };
    const curva = projetar(int, px(1290, 166)).s;
    // pneu chegando na tinta, sem passar dela (o critério antigo, pelo meio entre as faixas, já multava aqui)
    let b = await bancada('autoescola');
    percurso(b, curva, 1.1);
    expect(b.codigos()).not.toContain('linha_divisoria');
    // pneu já depois da tinta
    b = await bancada('autoescola');
    percurso(b, curva, 1.6);
    expect(b.codigos()).toContain('linha_divisoria');
    // linha tracejada da rua de baixo: cruzar é permitido
    b = await bancada('autoescola');
    percurso(b, projetar(int, px(1180, 1240)).s, 1.6, 8);
    expect(b.codigos()).not.toContain('linha_divisoria');
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

/** Bancada com examinador: o carro é teleportado e a prova + o examinador rodam a cada passo. */
async function cenario() {
  const b = await bancada('autoescola');
  const ex = new Examinador(b.sim, b.prova, { voz: false });
  const ext = faixaPorId('anel_externo');
  const int = faixaPorId('anel_interno');
  const spawn = b.mapa.spawn.posicao.clone().setY(0);
  let cab: Cabine = { seta: null, cinto: true };
  const rodar = (seg: number) => {
    for (let i = 0; i < Math.round(seg / DT); i++) {
      b.passo(cab);
      ex.atualizar(DT);
    }
  };
  const cabine = (c: Partial<Cabine>) => {
    cab = { ...cab, ...c };
  };
  const naFaixa = (f: typeof ext, s: number, vel = 6) => {
    const a = amostrar(f, s);
    b.colocar(a.ponto, a.direcao, vel);
    rodar(0.2);
  };
  /** Anda por uma faixa de s0 a s1 (passos de 0,5 m). */
  const andar = (f: typeof ext, s0: number, s1: number, vel = 6) => {
    for (let s = s0; s <= s1; s += 0.5) {
      const a = amostrar(f, s);
      b.colocar(a.ponto, a.direcao, vel);
      rodar(0.5 / vel);
    }
  };
  const zona = (nome: string) => b.mapa.zonas.find((x) => x.nome.toUpperCase() === nome)!;
  const eixo = (z: Zona) =>
    new THREE.Vector3().setFromMatrixColumn(new THREE.Matrix4().copy(z.inversa).invert(), 2).setY(0).normalize();
  /** Atravessa a zona no sentido do trânsito; com `pararEm`, para 1,5 s nessa posição (m a partir do centro). */
  const atravessar = (nome: string, pararEm: number | null = null, faixa?: typeof ext) => {
    const z = zona(nome);
    const e = eixo(z);
    const base = faixa ? projetar(faixa, z.centro).ponto : z.centro.clone();
    let parou = false;
    for (let d = -z.max.z - 2; d <= z.max.z + 3; d += 0.5) {
      const p = base.clone().setY(0).addScaledVector(e, d);
      if (pararEm !== null && !parou && d >= pararEm) {
        parou = true;
        b.colocar(p, e, 0);
        rodar(1.5);
      }
      b.colocar(p, e, 3);
      rodar(0.05);
    }
  };
  /** Coloca parado numa pose (x, y da planta). */
  const pararEm = (xp: number, yp: number, dir: THREE.Vector3, seg: number) => {
    b.colocar(px(xp, yp), dir, 0);
    rodar(seg);
  };
  return { ...b, ex, ext, int, spawn, rodar, cabine, naFaixa, andar, atravessar, zona, eixo, pararEm };
}

const SUL = new THREE.Vector3(0, 0, 1);
const NORTE = new THREE.Vector3(0, 0, -1);
/**
 * Faltas, menos os artefatos do teleporte: a freada brusca (a velocidade cai a zero de um passo
 * para o outro) e a seta da saída da vaga inicial (o carro "sai" do spawn ao ser teleportado).
 */
const todas = (c: Awaited<ReturnType<typeof cenario>>) =>
  c.prova.faltas
    .filter((f) => f.codigo !== 'freada_brusca' && !(f.codigo === 'sem_seta' && /vaga/.test(f.descricao)))
    .map((f) => f.codigo);

describe('examinador: trajeto completo', () => {
  it('teleportando pelo trajeto inteiro, faz todas as etapas sem "não seguiu a instrução" e encerra', async () => {
    const c = await cenario();
    c.prova.iniciada = false;
    c.rodar(0.1);
    expect(c.ex.idEtapa).toBe('partida');
    expect(c.ex.instrucao).toMatch(/cinto/);
    expect(c.ex.totalEtapas).toBe(20);
    c.prova.iniciada = true;
    c.rodar(0.1);
    expect(c.ex.idEtapa).toBe('saida');
    expect(c.ex.instrucao).toMatch(/direita/);

    // saída: seta e direita (sem PARE no estacionamento)
    c.cabine({ seta: 'direita' });
    c.rodar(0.2);
    c.cabine({ seta: null });
    c.naFaixa(c.ext, projetar(c.ext, c.spawn).s + 10);
    expect(c.ex.idEtapa).toBe('rampa');
    expect(c.ex.instrucao).toMatch(/rampa/);

    // rampa: para no meio da subida e segue
    c.atravessar('ZONA_RAMPA_1', 0, c.ext);
    expect(c.ex.idEtapa).toBe('farol');
    expect(c.ex.instrucao).toMatch(/farol/);
    c.cabine({ farol: true });
    c.rodar(0.5);
    expect(c.ex.idEtapa).toBe('semaforo_cima');

    // semáforo de cima (verde para a rua no início do ciclo)
    c.sim.tempo = 1000 * 35 + 2;
    c.atravessar('LINHA_PARADA_2');
    expect(c.ex.idEtapa).toBe('meio_fio');

    // meio-fio: vem com a seta à direita e para a 30 cm
    const sIni = projetar(c.ext, px(121, 820)).s;
    c.cabine({ seta: 'direita' });
    c.andar(c.ext, sIni - 40, sIni);
    expect(c.ex.instrucao).toMatch(/meio-fio/);
    const mL = c.sim.carro.cfg.carroceria.meiaLargura;
    const xMeioFio = px(80, 900).x;
    c.colocar(new THREE.Vector3(xMeioFio + 0.3 + mL, 0, px(0, 900).z), SUL, 0);
    c.cabine({ seta: null });
    c.rodar(2);
    expect(c.ex.idEtapa).toBe('alerta');
    c.cabine({ alerta: true });
    c.rodar(0.3);
    expect(c.ex.idEtapa).toBe('retomar');
    c.cabine({ alerta: false, seta: 'esquerda' });
    c.rodar(0.3);
    c.andar(c.ext, projetar(c.ext, px(121, 900)).s, projetar(c.ext, px(121, 900)).s + 8, 3);
    c.cabine({ seta: null });
    expect(c.ex.idEtapa).toBe('passagem_nivel_1');

    // passagem de nível (para antes dos trilhos) e avenida
    c.atravessar('ZONA_PARE_PN_1', 0);
    expect(c.ex.idEtapa).toBe('avenida');
    expect(c.ex.instrucao).toMatch(/avenida/);
    c.naFaixa(faixaPorId('diagonal_2'), 10);
    expect(c.ex.idEtapa).toBe('semaforo_avenida');
    c.sim.tempo = 1000 * 35 + 22; // verde da avenida
    c.atravessar('LINHA_PARADA_1');
    expect(c.ex.idEtapa).toBe('vaga_90');
    expect(c.ex.instrucao).toMatch(/PARE/);

    // vaga a 90°: entra de frente na vaga 2 e para inteiro dentro
    c.pararEm(1122, 260, SUL, 2.5);
    expect(c.ex.idEtapa).toBe('sair_vaga');
    c.naFaixa(c.int, projetar(c.int, px(1300, 175)).s);
    expect(c.ex.idEtapa).toBe('passagem_nivel_2');
    c.atravessar('ZONA_PARE_PN_2', 0);
    expect(c.ex.idEtapa).toBe('baliza');
    c.prova.balizaInicio = c.sim.tempo;
    c.prova.balizaConcluida = 60;
    c.rodar(0.1);
    expect(c.ex.idEtapa).toBe('sair_baliza');
    const baliza = c.mapa.zonas.find((z) => z.tipo === 'baliza')!;
    c.naFaixa(c.int, projetar(c.int, baliza.centro).s + 22);
    expect(c.ex.idEtapa).toBe('semaforo_esquerda');
    c.sim.tempo = 1000 * 35 + 2;
    c.atravessar('LINHA_PARADA_3');
    expect(c.ex.idEtapa).toBe('estacionamento');

    // entra no estacionamento, meia-volta com ré, estaciona
    c.pararEm(1150, 1400, SUL, 0.2);
    expect(c.ex.idEtapa).toBe('meia_volta');
    expect(c.prova.emManobra).toBe(true);
    meiaVolta(c, true);
    expect(c.ex.idEtapa).toBe('estacionar');
    c.colocar(c.spawn, NORTE, 0);
    c.rodar(2.5);
    expect(c.ex.concluido).toBe(true);
    expect(c.prova.encerrada).toBe(true);
    expect(c.prova.emManobra).toBe(false);
    const cod = todas(c);
    expect(cod).not.toContain('nao_seguiu_instrucao');
    expect(cod).not.toContain('avancou_vermelho');
    expect(cod).not.toContain('nao_parou_pare');
    expect(cod).not.toContain('nao_parou_linha_ferrea');
    expect(cod).not.toContain('parou_afastado_meio_fio');
    expect(cod).not.toContain('vaga_fora');
  });

  it('errar a entrada da avenida manda dar mais uma volta (volta à passagem de nível)', async () => {
    const c = await cenario();
    c.rodar(0.1);
    c.ex.pular('avenida');
    const sEntrada = projetar(c.ext, faixaPorId('diagonal_2').pontos[0]).s;
    for (let i = 0; i < 8; i++) c.naFaixa(c.ext, sEntrada + 22);
    expect(todas(c)).toContain('nao_seguiu_instrucao');
    expect(c.ex.idEtapa).toBe('passagem_nivel_1');
  });
});

/** Gira 180° no estacionamento: 1º movimento à frente, 2º de ré (se `comRe`), 3º à frente. */
function meiaVolta(c: Awaited<ReturnType<typeof cenario>>, comRe: boolean) {
  const centro = px(1150, 1420);
  const fases = [
    { de: 0, ate: Math.PI / 2, vel: 2 },
    { de: Math.PI / 2, ate: (3 * Math.PI) / 4, vel: comRe ? -1.5 : 2 },
    { de: (3 * Math.PI) / 4, ate: Math.PI, vel: 2 },
  ];
  for (const f of fases) {
    for (let k = 0; k <= 20; k++) {
      const yaw = f.de + ((f.ate - f.de) * k) / 20;
      const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      c.colocar(centro, dir, f.vel);
      c.rodar(0.1);
    }
  }
}

describe('examinador: manobras novas', () => {
  it('rampa: passar direto sem parar é "não seguiu a instrução" e segue para o farol', async () => {
    const c = await cenario();
    c.rodar(0.1);
    c.ex.pular('rampa');
    c.atravessar('ZONA_RAMPA_1', null, c.ext);
    c.rodar(1);
    expect(todas(c)).toEqual(['nao_seguiu_instrucao']);
    expect(c.ex.idEtapa).toBe('farol');
  });

  it('rampa: parar e deixar o carro voltar é falta (com duas zonas de rampa no mapa)', async () => {
    const c = await cenario();
    c.rodar(0.1);
    c.ex.pular('rampa');
    const z = c.zona('ZONA_RAMPA_1');
    const e = c.eixo(z);
    const p0 = projetar(c.ext, z.centro).ponto.setY(0);
    c.colocar(p0, e, 0);
    c.rodar(1.5);
    for (let k = 1; k <= 10; k++) {
      c.colocar(p0.clone().addScaledVector(e, -0.1 * k), e, -0.3);
      c.rodar(0.1);
    }
    expect(todas(c)).toEqual(['recuou_rampa']);
    expect(c.ex.idEtapa).toBe('rampa'); // parou: falta seguir em frente
  });

  it('farol: não acender em 5 s é falta; acender conclui; sem o dado do farol, não cobra', async () => {
    for (const caso of ['nao', 'sim', 'sem_dado'] as const) {
      const c = await cenario();
      c.rodar(0.1);
      if (caso !== 'sem_dado') c.cabine({ farol: false });
      c.ex.pular('farol');
      c.rodar(1);
      if (caso === 'sim') c.cabine({ farol: true });
      c.rodar(5.5);
      expect(c.ex.idEtapa).toBe('semaforo_cima');
      expect(todas(c)).toEqual(caso === 'nao' ? ['nao_seguiu_instrucao'] : []);
    }
  });

  it('meio-fio: até 50 cm sem falta; 80 cm leve; 1,5 m média; sem seta é grave (art. 196)', async () => {
    const casos = [
      { d: 0.3, seta: true, esperado: [] as string[], grav: null },
      { d: 0.8, seta: true, esperado: ['parou_afastado_meio_fio'], grav: 'leve' },
      { d: 1.5, seta: true, esperado: ['parou_afastado_meio_fio'], grav: 'media' },
      { d: 0.3, seta: false, esperado: ['parou_sem_seta'], grav: null },
    ];
    for (const k of casos) {
      const c = await cenario();
      c.rodar(0.1);
      c.ex.pular('meio_fio');
      const sIni = projetar(c.ext, px(121, 820)).s;
      c.cabine({ seta: k.seta ? 'direita' : null });
      c.andar(c.ext, sIni - 10, sIni + 2, 4);
      const mL = c.sim.carro.cfg.carroceria.meiaLargura;
      c.colocar(new THREE.Vector3(px(80, 900).x + k.d + mL, 0, px(0, 900).z), SUL, 0);
      c.rodar(2);
      expect(c.ex.idEtapa).toBe('alerta');
      expect([k.d, ...todas(c)]).toEqual([k.d, ...k.esperado]);
      if (k.grav) expect(c.prova.faltas.find((f) => f.codigo === 'parou_afastado_meio_fio')!.gravidade).toBe(k.grav);
    }
  });

  it('meio-fio: passar do trecho sem parar é falta e pula para a passagem de nível', async () => {
    const c = await cenario();
    c.rodar(0.1);
    c.ex.pular('meio_fio');
    const s = projetar(c.ext, px(121, 820)).s;
    c.andar(c.ext, s - 5, s + 20);
    expect(todas(c)).toEqual(['nao_seguiu_instrucao']);
    expect(c.ex.idEtapa).toBe('passagem_nivel_1');
  });

  it('pisca-alerta: pedido parado; andar com ele ligado é média (art. 251, I); retomar sem seta é falta', async () => {
    const c = await cenario();
    c.rodar(0.1);
    c.cabine({ alerta: false });
    c.ex.pular('meio_fio');
    const mL = c.sim.carro.cfg.carroceria.meiaLargura;
    c.cabine({ seta: 'direita' });
    const sIni = projetar(c.ext, px(121, 820)).s;
    c.andar(c.ext, sIni - 6, sIni + 2, 3);
    c.colocar(new THREE.Vector3(px(80, 900).x + 0.2 + mL, 0, px(0, 900).z), SUL, 0);
    c.cabine({ seta: null });
    c.rodar(2);
    expect(c.ex.idEtapa).toBe('alerta');
    c.rodar(6); // não liga
    expect(todas(c)).toEqual(['nao_seguiu_instrucao']);
    expect(c.ex.idEtapa).toBe('retomar');
    // liga o alerta agora e sai andando com ele, sem seta
    c.cabine({ alerta: true });
    c.andar(c.ext, projetar(c.ext, px(121, 900)).s, projetar(c.ext, px(121, 900)).s + 25, 4);
    expect(todas(c)).toEqual(['nao_seguiu_instrucao', 'sem_seta', 'pisca_alerta_movimento']);
    expect(c.prova.faltas.find((f) => f.codigo === 'pisca_alerta_movimento')!.gravidade).toBe('media');
    expect(c.ex.idEtapa).toBe('passagem_nivel_1');
  });

  it('pisca-alerta: parado não é falta, nem sem o dado da cabine', async () => {
    const c = await cenario();
    const a = amostrar(c.ext, 50);
    c.cabine({ alerta: true });
    c.colocar(a.ponto, a.direcao, 0);
    c.rodar(5);
    c.cabine({ alerta: undefined });
    c.colocar(a.ponto, a.direcao, 5);
    c.rodar(5);
    expect(todas(c)).not.toContain('pisca_alerta_movimento');
  });

  it('vaga a 90°: inteiro dentro conclui; parte para fora é falta; estourar o tempo é grave', async () => {
    // dentro (de ré, na vaga 1)
    let c = await cenario();
    c.rodar(0.1);
    c.ex.pular('vaga_90');
    c.pararEm(982, 235, NORTE, 2.5);
    expect(c.ex.idEtapa).toBe('sair_vaga');
    expect(todas(c)).toEqual([]);

    // traseira para fora da vaga 2 (centro logo depois da entrada, de frente para o sul)
    c = await cenario();
    c.rodar(0.1);
    c.ex.pular('vaga_90');
    c.pararEm(1122, 195, SUL, 6);
    expect(todas(c)).toEqual(['vaga_fora']);
    expect(c.ex.idEtapa).toBe('sair_vaga');

    // não estaciona: tempo esgotado
    c = await cenario();
    c.rodar(0.1);
    c.ex.pular('vaga_90');
    c.pararEm(1122, 120, new THREE.Vector3(1, 0, 0), 181);
    expect(todas(c)).toEqual(['vaga_tempo']);
    expect(c.prova.faltas.find((f) => f.codigo === 'vaga_tempo')!.gravidade).toBe('grave');
    expect(c.ex.idEtapa).toBe('sair_vaga');
  });

  it('vaga a 90°: passar direto pelas vagas é falta e segue a volta (passagem de nível 2)', async () => {
    const c = await cenario();
    c.rodar(0.1);
    c.ex.pular('vaga_90');
    const s = projetar(c.int, px(1300, 175)).s;
    c.andar(c.int, s - 25, s + 4);
    expect(todas(c)).toEqual(['nao_seguiu_instrucao']);
    expect(c.ex.idEtapa).toBe('passagem_nivel_2');
  });

  it('meia-volta: com ré conclui; sem ré é falta; sair do estacionamento é falta e vai estacionar', async () => {
    let c = await cenario();
    c.rodar(0.1);
    c.ex.pular('meia_volta');
    meiaVolta(c, true);
    expect(c.ex.idEtapa).toBe('estacionar');
    expect(todas(c)).toEqual([]);

    c = await cenario();
    c.rodar(0.1);
    c.ex.pular('meia_volta');
    meiaVolta(c, false);
    expect(c.ex.idEtapa).toBe('estacionar');
    expect(todas(c)).toEqual(['nao_seguiu_instrucao']);
    expect(c.prova.faltas.find((f) => f.codigo === 'nao_seguiu_instrucao')!.descricao).toMatch(/ré/);

    c = await cenario();
    c.rodar(0.1);
    c.ex.pular('meia_volta');
    c.pararEm(1150, 1420, SUL, 0.5);
    c.colocar(px(1150, 1250), NORTE, 3);
    c.rodar(1.5);
    expect(todas(c)).toEqual(['nao_seguiu_instrucao']);
    expect(c.ex.idEtapa).toBe('estacionar');
  });

  it('estacionar: sem estacionar em 3 min, falta e a prova é encerrada', async () => {
    const c = await cenario();
    c.rodar(0.1);
    c.ex.pular('estacionar');
    c.pararEm(1400, 1420, NORTE, 181);
    expect(todas(c)).toEqual(['nao_seguiu_instrucao']);
    expect(c.prova.encerrada).toBe(true);
    expect(c.ex.concluido).toBe(true);
  });
});

describe('prova: semáforos e passagem de nível da autoescola', () => {
  /** Cenário com o examinador numa etapa que não cobra caminho (só a prova avalia). */
  const neutro = async () => {
    const c = await cenario();
    c.ex.pular('semaforo_cima');
    return c;
  };
  it('semáforos 1–3: cruzar a linha no vermelho é gravíssima; no verde, não', async () => {
    // rua (2 e 3): verde 0–15 s do ciclo de 35; avenida (1): verde 20–32
    for (const [nome, verde, vermelho] of [
      ['LINHA_PARADA_1', 22, 5],
      ['LINHA_PARADA_2', 5, 25],
      ['LINHA_PARADA_3', 5, 25],
    ] as const) {
      for (const [t, falta] of [[verde, false], [vermelho, true]] as const) {
        const c = await neutro();
        c.sim.tempo = 35 * 100 + t;
        c.atravessar(nome);
        const f = c.prova.faltas.filter((x) => x.codigo === 'avancou_vermelho');
        expect([nome, t, f.length]).toEqual([nome, t, falta ? 1 : 0]);
        if (falta) expect(f[0].gravidade).toBe('gravissima');
      }
    }
  });

  it('passagem de nível: sem parar é gravíssima (art. 212); parando, não; com a passagem fechada, avançou (art. 210)', async () => {
    for (const nome of ['ZONA_PARE_PN_1', 'ZONA_PARE_PN_2']) {
      let c = await neutro();
      c.atravessar(nome);
      expect(todas(c)).toEqual(['nao_parou_linha_ferrea']);
      c = await neutro();
      c.atravessar(nome, 0);
      expect(todas(c)).toEqual([]);
      c = await neutro();
      c.trafego.passagemFechada = true;
      c.atravessar(nome, 0);
      expect(todas(c)).toEqual(['avancou_passagem_nivel']);
    }
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
      // o percurso anda sem parar: passar direto por PARE, trilhos e semáforo é falta esperada aqui
      const c = b.codigos().filter((x) => !['nao_parou_pare', 'nao_parou_linha_ferrea', 'avancou_vermelho'].includes(x));
      expect([id, ...c]).toEqual([id]);
    }
  });
});
