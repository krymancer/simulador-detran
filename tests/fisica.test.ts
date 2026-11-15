import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { KWID } from '../src/sim/carConfig';
import { Comandos, COMANDOS_NEUTROS } from '../src/sim/powertrain';
import { iniciarRapier, Simulacao, HZ_FISICA } from '../src/sim/simulation';
import { lerMapa } from '../src/world/parser';

/** Chão plano grande ou rampa com inclinação `graus` (subindo para +Z). */
function mapaTeste(graus = 0): Simulacao {
  const raiz = new THREE.Group();
  const chao = new THREE.Mesh(new THREE.BoxGeometry(400, 1, 400));
  chao.name = 'COL_chao';
  chao.rotation.x = -(graus * Math.PI) / 180;
  chao.position.y = -0.5 / Math.cos((graus * Math.PI) / 180);
  raiz.add(chao);
  const spawn = new THREE.Object3D();
  spawn.name = 'SPAWN_CARRO';
  spawn.rotation.y = Math.PI; // −Z local → +Z mundo
  raiz.add(spawn);
  return new Simulacao(lerMapa(raiz), KWID);
}

function rodar(sim: Simulacao, segundos: number, cmd: (t: number) => Partial<Comandos>, cada?: (t: number) => boolean | void): number {
  const n = Math.round(segundos * HZ_FISICA);
  const t0 = sim.tempo;
  for (let i = 0; i < n; i++) {
    const t = sim.tempo - t0;
    sim.passo({ ...COMANDOS_NEUTROS, ...cmd(t) });
    if (cada && cada(sim.tempo - t0) === true) return sim.tempo - t0;
  }
  return sim.tempo - t0;
}

function ligar(sim: Simulacao, base: Partial<Comandos> = {}): void {
  rodar(sim, 1.0, () => ({ ...base, partida: true, embreagem: 1 }));
  rodar(sim, 2.0, () => ({ ...base, embreagem: 1 }));
}

/**
 * Pedal de embreagem como um motorista faz: sobe rápido até perto do ponto,
 * solta devagar no ponto, depois solta o resto.
 */
function pedalSuave(t: number, rapido: number, ponto: number): number {
  if (t < rapido) return 1 - (0.35 * t) / rapido;           // 1 → 0.65
  if (t < rapido + ponto) return 0.65 - (0.35 * (t - rapido)) / ponto; // 0.65 → 0.30
  return Math.max(0, 0.3 - (0.3 * (t - rapido - ponto)) / 0.8);
}

const kmh = (sim: Simulacao) => sim.carro.velocidadeLongitudinal() * 3.6;
const pos = (sim: Simulacao) => {
  const t = sim.carro.corpo.translation();
  return new THREE.Vector3(t.x, t.y, t.z);
};

beforeAll(async () => {
  await iniciarRapier();
});

describe('física do Kwid', () => {
  it('assenta na suspensão e fica parado', () => {
    const sim = mapaTeste();
    rodar(sim, 3, () => ({}));
    const p = pos(sim);
    const lv = sim.carro.corpo.linvel();
    const v = Math.hypot(lv.x, lv.z);
    const comp = sim.carro.rodas.map((r) => r.comprimento.toFixed(3));
    console.log('altura CG', p.y.toFixed(3), 'comprimentos', comp.join(' '), 'v', v.toFixed(4));
    expect(Math.abs(p.y - KWID.alturaCG)).toBeLessThan(0.05);
    expect(v).toBeLessThan(0.01);
  });

  it('dá partida e segura a marcha lenta', () => {
    const sim = mapaTeste();
    ligar(sim);
    rodar(sim, 3, () => ({}));
    console.log('marcha lenta', sim.carro.trem.rpm.toFixed(0));
    expect(sim.carro.trem.ligado).toBe(true);
    expect(Math.abs(sim.carro.trem.rpm - KWID.motor.rpmMarchaLenta)).toBeLessThan(80);
  });

  it('soltar a embreagem de uma vez em 1ª sem acelerar → apaga', () => {
    const sim = mapaTeste();
    ligar(sim);
    rodar(sim, 0.5, () => ({ marcha: 1, embreagem: 1, freioDeMao: false }));
    rodar(sim, 2, () => ({ marcha: 1, embreagem: 0, freioDeMao: false }));
    expect(sim.carro.trem.ligado).toBe(false);
  });

  it('soltar a embreagem devagar em 1ª sem acelerar → anda sem apagar', () => {
    const sim = mapaTeste();
    ligar(sim);
    rodar(sim, 0.5, () => ({ marcha: 1, embreagem: 1, freioDeMao: false }));
    let minRpm = 9999;
    rodar(
      sim,
      6,
      (t) => ({ marcha: 1, embreagem: pedalSuave(t, 0.5, 3.5), freioDeMao: false }),
      () => { minRpm = Math.min(minRpm, sim.carro.trem.rpm); },
    );
    console.log('arrancada na lenta: v', kmh(sim).toFixed(1), 'km/h, rpm mín', minRpm.toFixed(0));
    expect(sim.carro.trem.ligado).toBe(true);
    expect(kmh(sim)).toBeGreaterThan(4);
  });

  it('0–100 km/h com aceleração total (troca a 6000 rpm)', () => {
    const sim = mapaTeste();
    ligar(sim);
    let marcha = 1;
    let fase: 'arrancada' | 'pisa' | 'engata' | 'solta' | 'acelera' = 'arrancada';
    let tf = 0; // tempo na fase
    const t100 = rodar(
      sim,
      40,
      () => {
        switch (fase) {
          case 'arrancada': return { marcha: 1, embreagem: Math.max(0, 1 - tf / 1.0), acelerador: 0.7, freioDeMao: false };
          case 'pisa': return { marcha: 0, embreagem: 1, acelerador: 0, freioDeMao: false };
          case 'engata': return { marcha, embreagem: 1, acelerador: 0, freioDeMao: false };
          case 'solta': return { marcha, embreagem: Math.max(0, 1 - tf / 0.3), acelerador: 1, freioDeMao: false };
          default: return { marcha, embreagem: 0, acelerador: 1, freioDeMao: false };
        }
      },
      () => {
        tf += 1 / HZ_FISICA;
        const troca = (f: typeof fase) => { fase = f; tf = 0; };
        if (fase === 'arrancada' && tf > 1.0) troca('acelera');
        else if (fase === 'acelera' && sim.carro.trem.rpm > 6000 && marcha < 5) troca('pisa');
        else if (fase === 'pisa' && tf > 0.2) { marcha++; troca('engata'); }
        else if (fase === 'engata' && tf > 0.15) troca('solta');
        else if (fase === 'solta' && tf > 0.3) troca('acelera');
        return kmh(sim) >= 100;
      },
    );
    console.log('0–100:', t100.toFixed(1), 's', 'marcha', marcha);
    // Kwid 1.0 real: ~14–15 s.
    expect(t100).toBeGreaterThan(11);
    expect(t100).toBeLessThan(19);
  });

  it('freia de 60 km/h até parar em distância plausível', () => {
    const sim = mapaTeste();
    ligar(sim);
    // empurra o carro a 60 km/h
    const q = sim.carro.corpo.rotation();
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    sim.carro.corpo.setLinvel({ x: f.x * 16.67, y: 0, z: f.z * 16.67 }, true);
    sim.carro.trem.omegaRoda.fill(16.67 / KWID.roda.raio);
    const p0 = pos(sim);
    rodar(sim, 6, () => ({ freio: 1, embreagem: 1, freioDeMao: false }), () => sim.carro.velocidade() < 0.05);
    const d = pos(sim).distanceTo(p0);
    console.log('frenagem 60–0:', d.toFixed(1), 'm');
    expect(d).toBeGreaterThan(13);
    expect(d).toBeLessThan(24);
  });

  it('segura na rampa de 15% com freio de mão', () => {
    const sim = mapaTeste(8.5);
    rodar(sim, 1, () => ({ freioDeMao: true }));
    const p0 = pos(sim);
    rodar(sim, 5, () => ({ freioDeMao: true }));
    const d = pos(sim).distanceTo(p0);
    console.log('deslizou na rampa:', (d * 100).toFixed(2), 'cm');
    expect(d).toBeLessThan(0.02);
  });

  it('sem freio, desce a rampa em ponto morto', () => {
    const sim = mapaTeste(8.5);
    rodar(sim, 4, () => ({ freioDeMao: false }));
    console.log('descendo a rampa sem freio:', kmh(sim).toFixed(1), 'km/h');
    expect(kmh(sim)).toBeLessThan(-5);
  });

  it('arranca na rampa de 15% sem recuar nem apagar (ponto da embreagem + freio de mão)', () => {
    const sim = mapaTeste(8.5);
    ligar(sim, { freioDeMao: true });
    const p0 = pos(sim);
    const frente = new THREE.Vector3(0, 0, 1);
    let menor = 0;
    rodar(
      sim,
      8,
      (t) => ({
        marcha: 1,
        acelerador: t < 1 ? 0 : 0.3,
        embreagem: t < 1 ? 1 : pedalSuave(t - 1, 0.5, 3),
        freioDeMao: t < 2.8, // solta o freio de mão quando sente o carro “puxar”
      }),
      () => { menor = Math.min(menor, pos(sim).sub(p0).dot(frente)); },
    );
    const avancou = pos(sim).sub(p0).dot(frente);
    console.log('arrancada na rampa: avançou', avancou.toFixed(1), 'm, recuo máx', (menor * 100).toFixed(1), 'cm, ligado', sim.carro.trem.ligado);
    expect(sim.carro.trem.ligado).toBe(true);
    expect(avancou).toBeGreaterThan(3);
    expect(menor).toBeGreaterThan(-0.1);
  });

  it('esterço total a baixa velocidade → raio de giro plausível', () => {
    const sim = mapaTeste();
    ligar(sim);
    rodar(sim, 0.5, () => ({ marcha: 1, embreagem: 1, freioDeMao: false }));
    const pontos: THREE.Vector3[] = [];
    rodar(
      sim,
      30,
      (t) => ({ marcha: 1, embreagem: pedalSuave(t, 0.5, 3.5), volante: 1, freioDeMao: false }),
      (t) => { if (t > 6) pontos.push(pos(sim)); },
    );
    // raio pelo bounding box da trajetória
    const box = new THREE.Box3().setFromPoints(pontos);
    const s = box.getSize(new THREE.Vector3());
    const raio = (s.x + s.z) / 4;
    console.log('raio de giro (CG):', raio.toFixed(2), 'm, v', kmh(sim).toFixed(1), 'km/h');
    // Kwid: diâmetro de giro ~9,8 m entre meios-fios → raio do CG ≈ 4 m
    expect(raio).toBeGreaterThan(3.2);
    expect(raio).toBeLessThan(5.5);
  });
});
