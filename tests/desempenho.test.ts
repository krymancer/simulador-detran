/**
 * Desempenho medido no simulador, para comparar com testes de revista:
 * 0–100 km/h, velocidade máxima, frenagem 100–0 e aderência lateral (g).
 * Rode com: npx vitest run tests/desempenho.test.ts --silent=false
 */
import { cargaBorboleta } from '../src/sim/powertrain';
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CarConfig, KWID, MOBI } from '../src/sim/carConfig';
import { Comandos, COMANDOS_NEUTROS } from '../src/sim/powertrain';
import { iniciarRapier, Simulacao, HZ_FISICA } from '../src/sim/simulation';
import { lerMapa } from '../src/world/parser';

function pista(cfg: CarConfig): Simulacao {
  const raiz = new THREE.Group();
  const chao = new THREE.Mesh(new THREE.BoxGeometry(6000, 1, 6000));
  chao.name = 'COL_chao';
  chao.position.y = -0.5;
  raiz.add(chao);
  const spawn = new THREE.Object3D();
  spawn.name = 'SPAWN_CARRO';
  spawn.position.z = -2800;
  spawn.rotation.y = Math.PI;
  raiz.add(spawn);
  return new Simulacao(lerMapa(raiz), cfg);
}

const kmh = (s: Simulacao) => s.carro.velocidadeLongitudinal() * 3.6;
const passo = (s: Simulacao, c: Partial<Comandos>) => s.passo({ ...COMANDOS_NEUTROS, freioDeMao: false, ...c });

function ligar(s: Simulacao): void {
  for (let i = 0; i < HZ_FISICA * 1; i++) passo(s, { partida: true, embreagem: 1, freioDeMao: false });
  for (let i = 0; i < HZ_FISICA * 1.5; i++) passo(s, { embreagem: 1, freioDeMao: false });
}

/** Arrancada de teste de revista: 1ª a ~3000 rpm, troca no corte, 0,35 s por troca. */
function arrancada(s: Simulacao, ate = 100, limite = 60) {
  ligar(s);
  const trem = s.carro.trem;
  let marcha = 1;
  let troca = -1; // tempo do início da troca
  const marcas: Record<number, number> = {};
  const dt = 1 / HZ_FISICA;
  let t = 0;
  let largou = false;
  const rpmTroca = s.carro.cfg.motor.rpmCorte - 250;
  while (t < limite) {
    const v = kmh(s);
    for (const alvo of [40, 60, 80, 100, 120]) if (marcas[alvo] === undefined && v >= alvo) marcas[alvo] = t;
    if (v >= ate) break;
    let c: Partial<Comandos>;
    if (!largou) {
      // segura a 3000 rpm com a embreagem no fundo, então solta em 0,4 s
      if (trem.rpm < 3000 && t < 1.5) { c = { marcha: 1, embreagem: 1, acelerador: 1 }; t = 0; }
      else { largou = true; c = { marcha: 1, embreagem: 1, acelerador: 1 }; }
      if (!largou) { passo(s, c); continue; }
    }
    if (troca < 0 && marcha < 5 && trem.rpm > rpmTroca) { troca = t; }
    if (troca >= 0) {
      const dtt = t - troca;
      if (dtt < 0.2) c = { marcha, embreagem: 1, acelerador: 0 };
      else if (dtt < 0.35) c = { marcha: marcha + 1, embreagem: 1 - (dtt - 0.2) / 0.15, acelerador: 0.4 };
      else { marcha++; troca = -1; c = { marcha, embreagem: 0, acelerador: 1 }; }
    } else {
      const lanc = Math.max(0, 1 - t / 0.5); // solta a embreagem em 0,5 s
      c = { marcha, embreagem: marcha === 1 ? lanc : 0, acelerador: 1 };
    }
    passo(s, c!);
    t += dt;
  }
  return { marcas, t };
}

function velocidadeMaxima(s: Simulacao): number {
  arrancada(s, 300, 50);
  let vmax = 0;
  for (let i = 0; i < HZ_FISICA * 60; i++) {
    passo(s, { marcha: 5, acelerador: 1 });
    vmax = Math.max(vmax, kmh(s));
  }
  return vmax;
}

function frenagem(s: Simulacao, de = 100): { metros: number; segundos: number; travou: boolean } {
  arrancada(s, de + 3, 60);
  // embalado e solto: pisa tudo de uma vez (com embreagem, como num teste)
  const p0 = s.carro.corpo.translation();
  let t = 0;
  let travou = false;
  while (kmh(s) > de) { passo(s, { marcha: 0, embreagem: 1 }); t += 1 / HZ_FISICA; }
  const ini = s.carro.corpo.translation();
  t = 0;
  while (kmh(s) > 0.5 && t < 20) {
    passo(s, { marcha: 0, embreagem: 1, freio: 1 });
    if (kmh(s) > 10 && s.carro.trem.travada.some(Boolean)) travou = true; // ABS: não pode travar andando
    t += 1 / HZ_FISICA;
  }
  const fim = s.carro.corpo.translation();
  void p0;
  return { metros: Math.hypot(fim.x - ini.x, fim.z - ini.z), segundos: t, travou };
}

/** Volante fixo e velocidade subindo devagar: a lateral máxima (v · guinada) é a aderência. */
function aderenciaLateral(s: Simulacao, volante = 0.12): { g: number; kmh: number; deriva: number; derivaMax: number } {
  ligar(s);
  let melhor = 0, vMelhor = 0, aMedia = 0, derivaMelhor = 0, derivaMax = 0;
  const vAnt = new THREE.Vector3();
  let alvo = 15;
  let marcha = 1, trocaAte = -1;
  for (let i = 0; i < HZ_FISICA * 90; i++) {
    const t = i / HZ_FISICA;
    alvo = 15 + t * 0.9; // +0,9 km/h por segundo
    const v = kmh(s);
    const quer = v < 22 ? 1 : v < 42 ? 2 : 3;
    if (quer > marcha && trocaAte < 0) { marcha = quer; trocaAte = t + 0.3; }
    const trocando = trocaAte > t;
    if (!trocando) trocaAte = -1;
    const erro = alvo - v;
    const lanc = Math.max(0, 1 - t / 1.5);
    passo(s, {
      marcha, embreagem: trocando ? 1 : marcha === 1 ? lanc : 0,
      acelerador: trocando ? 0 : Math.min(1, Math.max(0, 0.2 + erro * 0.15)), volante,
    });
    // aceleração lateral de verdade (derivada da velocidade, no eixo lateral do carro), média de 0,5 s
    const lv = s.carro.corpo.linvel();
    const rq = s.carro.corpo.rotation();
    const lado = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(rq.x, rq.y, rq.z, rq.w));
    const vAtual = new THREE.Vector3(lv.x, lv.y, lv.z);
    if (i > 0) {
      const aLat = vAtual.clone().sub(vAnt).multiplyScalar(HZ_FISICA).dot(lado);
      aMedia += (aLat - aMedia) * (1 / (HZ_FISICA * 0.5));
    }
    vAnt.copy(vAtual);
    const deriva = Math.atan2(vAtual.dot(lado), Math.max(0.1, s.carro.velocidadeLongitudinal())) * 180 / Math.PI;
    const a = Math.abs(aMedia) / 9.81;
    if (t > 5 && a > melhor) { melhor = a; vMelhor = v; derivaMelhor = deriva; }
    if (Math.abs(deriva) > derivaMax) derivaMax = Math.abs(deriva);
  }
  return { g: melhor, kmh: vMelhor, deriva: derivaMelhor, derivaMax };
}

/** Retomada: embala até `de` em `marcha`, então pé no fundo até `ate`. */
function retomada(s: Simulacao, marcha: number, de: number, ate: number): number {
  arrancada(s, de - 2, 60);
  // troca para a marcha pedida com embreagem e espera estabilizar em `de`
  for (let i = 0; i < HZ_FISICA * 0.4; i++) passo(s, { marcha, embreagem: 1 });
  for (let i = 0; i < HZ_FISICA * 0.3; i++) passo(s, { marcha, embreagem: 1 - i / (HZ_FISICA * 0.3) });
  let k = 0;
  while (kmh(s) < de && k++ < HZ_FISICA * 30) passo(s, { marcha, acelerador: 0.5 });
  while (kmh(s) > de + 0.5 && k++ < HZ_FISICA * 30) passo(s, { marcha, acelerador: 0 });
  let t = 0;
  while (kmh(s) < ate && t < 60) { passo(s, { marcha, acelerador: 1 }); t += 1 / HZ_FISICA; }
  return t;
}

beforeAll(async () => { await iniciarRapier(); });

describe('borboleta', () => {
  it('pedal parcial dá muito torque em giro baixo e pouco em giro alto', () => {
    const linhas = [0.1, 0.2, 0.3, 0.5, 0.75, 1].map((p) =>
      `pedal ${String(p * 100).padStart(3)}%: ` + [1000, 2000, 3000, 4500, 6000].map((r) => `${r} rpm ${(cargaBorboleta(p, r, 23000) * 100).toFixed(0).padStart(3)}%`).join(' · '));
    console.log(linhas.join('\n'));
    expect(cargaBorboleta(0.3, 1500, 23000)).toBeGreaterThan(0.7);
    expect(cargaBorboleta(0.3, 5500, 23000)).toBeLessThan(0.5);
    expect(cargaBorboleta(1, 6000, 23000)).toBeCloseTo(1);
  });
});

describe.each([['Mobi', MOBI], ['Kwid', KWID]] as const)('desempenho %s', (nome, cfg) => {
  it('mede e imprime', () => {
    const a = arrancada(pista(cfg), 120, 60);
    const vmax = velocidadeMaxima(pista(cfg));
    const f = frenagem(pista(cfg));
    const lat = aderenciaLateral(pista(cfg));
    const fmt = (x?: number) => (x === undefined ? '—' : x.toFixed(1) + ' s');
    console.log(
      `${nome}: 0-40 ${fmt(a.marcas[40])} · 0-60 ${fmt(a.marcas[60])} · 0-80 ${fmt(a.marcas[80])} · 0-100 ${fmt(a.marcas[100])} · 0-120 ${fmt(a.marcas[120])}` +
        ` | máx ${vmax.toFixed(0)} km/h | 100-0 ${f.metros.toFixed(1)} m (${f.segundos.toFixed(1)} s${f.travou ? ', travou' : ''})` +
        ` | lateral ${lat.g.toFixed(2)} g a ${lat.kmh.toFixed(0)} km/h (deriva ${lat.deriva.toFixed(1)}°, máx ${lat.derivaMax.toFixed(1)}°)`,
    );
    const r1 = retomada(pista(cfg), 3, 40, 80);
    const r2 = retomada(pista(cfg), 4, 60, 100);
    const r3 = retomada(pista(cfg), 5, 80, 120);
    console.log(`${nome} retomadas: 40-80 (3ª) ${r1.toFixed(1)} s · 60-100 (4ª) ${r2.toFixed(1)} s · 80-120 (5ª) ${r3.toFixed(1)} s`);
    // mapa do pedal: fração do torque máximo naquele giro
    // Faixas de referência (carro real, 1.0 aspirado, 2 pessoas):
    // 0–100: fábrica ~14–15 s, revistas 17–17,5 s; máx ~150–160; 100–0 ~40–45 m; pneu econômico ~0,75–0,85 g.
    expect(a.marcas[100]).toBeGreaterThan(13);
    expect(a.marcas[100]).toBeLessThan(18);
    expect(vmax).toBeGreaterThan(140);
    expect(vmax).toBeLessThan(165);
    expect(f.metros).toBeGreaterThan(36);
    expect(f.metros).toBeLessThan(48);
    expect(f.travou).toBe(false);
    expect(lat.g).toBeGreaterThan(0.7);
    expect(lat.g).toBeLessThan(0.9);
  });
});
