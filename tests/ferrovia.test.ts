import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MOBI } from '../src/sim/carConfig';
import { COMANDOS_NEUTROS } from '../src/sim/powertrain';
import { DT_FISICA, HZ_FISICA, iniciarRapier, Simulacao } from '../src/sim/simulation';
import { lerMapa } from '../src/world/parser';
import { criarMapaAutoescola } from '../src/world/autoescola';
import { Ferrovia, type EstadoPassagem } from '../src/world/ferrovia';

beforeAll(async () => {
  await iniciarRapier();
});

function novo() {
  const sim = new Simulacao(lerMapa(criarMapaAutoescola()), MOBI);
  const ferrovia = new Ferrovia(sim, { visuais: false, intervalo: 5 });
  return { sim, ferrovia };
}

describe('ferrovia e passagem de nível', () => {
  it('ciclo livre → alerta → fechada → livre; trem cruza a rua e para na estação', () => {
    const { sim, ferrovia } = novo();
    const { centro, meiaLarguraTrilhos } = ferrovia.cruzamento;
    expect(meiaLarguraTrilhos).toBeGreaterThan(1);
    expect(ferrovia.estado).toBe('livre');

    const sequencia: EstadoPassagem[] = [ferrovia.estado];
    let menorFrente = Infinity;
    let cruzou = false;
    let parouNaEstacao = false;
    let tempoAlertaAntesDeOcupar = -1;
    let tAlerta = -1;
    const zNorteRua = centro.z - 3.6;
    for (let i = 0; i < 120 * HZ_FISICA; i++) {
      ferrovia.passo(DT_FISICA);
      sim.passo(COMANDOS_NEUTROS);
      const e = ferrovia.estado;
      if (e !== sequencia[sequencia.length - 1]) sequencia.push(e);
      if (e === 'alerta' && tAlerta < 0) tAlerta = i * DT_FISICA;
      const t = ferrovia.estadoTrem();
      menorFrente = Math.min(menorFrente, t.zFrente);
      // trem em cima da rua → passagem tem que estar fechada
      if (t.zFrente < centro.z + 3.6 && t.zTras > zNorteRua) {
        expect(e).toBe('fechada');
        if (tempoAlertaAntesDeOcupar < 0) tempoAlertaAntesDeOcupar = i * DT_FISICA - tAlerta;
      }
      if (t.zTras < centro.z) cruzou = true;
      if (t.fase === 'estacao') {
        parouNaEstacao = true;
        expect(t.velocidade).toBe(0);
        // trem inteiro ao norte da rua, com folga
        expect(t.zTras).toBeLessThan(zNorteRua - 2);
      }
      expect(ferrovia.sinoTocando).toBe(e !== 'livre');
    }
    const texto = sequencia.join(',');
    expect(texto).toContain('livre,alerta,fechada');
    expect(sequencia.lastIndexOf('livre')).toBeGreaterThan(sequencia.indexOf('fechada'));
    expect(cruzou).toBe(true);
    expect(parouNaEstacao).toBe(true);
    expect(menorFrente).toBeLessThan(centro.z - 25);
    // ~25 s de aviso antes de o trem chegar à rua
    expect(tempoAlertaAntesDeOcupar).toBeGreaterThan(22);
    expect(tempoAlertaAntesDeOcupar).toBeLessThan(28);
    expect(ferrovia.eventos()).toEqual([]);
    ferrovia.liberar();
    sim.liberar();
  });

  it('carro parado em cima da linha é atingido pelo trem: colisao_trem uma vez', () => {
    const { sim, ferrovia } = novo();
    const { centro } = ferrovia.cruzamento;
    // carro atravessado na linha, na faixa norte, virado para oeste
    sim.carro.posicionar(new THREE.Vector3(centro.x, 0, centro.z - 1.8), -Math.PI / 2);
    const eventos: string[] = [];
    let empurrado = false;
    for (let i = 0; i < 60 * HZ_FISICA; i++) {
      ferrovia.passo(DT_FISICA);
      sim.passo(COMANDOS_NEUTROS);
      eventos.push(...ferrovia.eventos());
      const p = sim.carro.corpo.translation();
      if (Math.hypot(p.x - centro.x, p.z - (centro.z - 1.8)) > 1) empurrado = true;
    }
    expect(eventos).toEqual(['colisao_trem']);
    expect(empurrado).toBe(true);
    // o carro não atravessou o trem: não ficou dentro do gabarito
    const p = sim.carro.corpo.translation();
    const t = ferrovia.estadoTrem();
    const dentro = Math.abs(p.x - t.x) < 1.2 && p.z > t.zFrente + 0.5 && p.z < t.zTras - 0.5;
    expect(dentro).toBe(false);

    ferrovia.reiniciar();
    expect(ferrovia.eventos()).toEqual([]);
    expect(ferrovia.estado).toBe('livre');
    ferrovia.liberar();
    sim.liberar();
  });

  it('cancela abaixada segura o carro devagar e quebra se o carro vier rápido', () => {
    const { sim, ferrovia } = novo();
    const { centro } = ferrovia.cruzamento;
    // espera a passagem fechar
    let i = 0;
    while (ferrovia.estado !== 'fechada' && i++ < 60 * HZ_FISICA) {
      ferrovia.passo(DT_FISICA);
      sim.passo(COMANDOS_NEUTROS);
    }
    expect(ferrovia.estado).toBe('fechada');
    // carro vindo do oeste pela faixa sul a ~8 m/s em direção à cancela
    sim.carro.posicionar(new THREE.Vector3(centro.x - 12, 0, centro.z + 1.8), Math.PI / 2);
    sim.carro.corpo.setLinvel({ x: 8, y: 0, z: 0 }, true);
    for (let k = 0; k < 2 * HZ_FISICA; k++) {
      ferrovia.passo(DT_FISICA);
      sim.passo(COMANDOS_NEUTROS);
    }
    expect(ferrovia.cancelaQuebrada).toBe(true);
    ferrovia.liberar();
    sim.liberar();
  });

  it('devagar, o carro esbarra na cancela abaixada e não passa', () => {
    const { sim, ferrovia } = novo();
    const { centro } = ferrovia.cruzamento;
    let i = 0;
    while (ferrovia.estado !== 'fechada' && i++ < 60 * HZ_FISICA) {
      ferrovia.passo(DT_FISICA);
      sim.passo(COMANDOS_NEUTROS);
    }
    // faixa norte, vindo do leste, empurrando devagar (~1 m/s) contra a cancela
    sim.carro.posicionar(new THREE.Vector3(centro.x + 7.5, 0, centro.z - 1.8), -Math.PI / 2);
    for (let k = 0; k < 4 * HZ_FISICA; k++) {
      const v = sim.carro.corpo.linvel();
      if (v.x > -1) sim.carro.corpo.applyImpulse({ x: -60, y: 0, z: 0 }, true);
      ferrovia.passo(DT_FISICA);
      sim.passo(COMANDOS_NEUTROS);
    }
    expect(ferrovia.cancelaQuebrada).toBe(false);
    // frente do carro não passou do braço (x da cancela = linha + 4,3 m)
    const p = sim.carro.colisor.translation();
    expect(p.x - MOBI.carroceria.meiaComprimento).toBeGreaterThan(centro.x + 4.3 - 0.2);
    ferrovia.liberar();
    sim.liberar();
  });
});
