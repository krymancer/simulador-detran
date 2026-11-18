import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MovimentoCabeca } from '../src/render/cabeca';

/** Carro andando para +Z com aceleração constante `a` (m/s², no eixo do carro) por `seg` segundos. */
function simular(a: THREE.Vector3, seg: number, yaw = 0) {
  const c = new MovimentoCabeca();
  const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const v = new THREE.Vector3(0, 0, 15).applyQuaternion(rot);
  const aMundo = a.clone().applyQuaternion(rot);
  const dt = 1 / 60;
  for (let t = 0; t < seg; t += dt) {
    v.addScaledVector(aMundo, dt);
    c.atualizar(dt, { vel: v.clone(), rot, dtSim: dt, rpm: 0, rpmLenta: 850, ligado: false, cilindros: 4, carga: 0 });
  }
  return c;
}

describe('movimento da cabeça', () => {
  it('freada de 0,8 g joga a cabeça ~3 cm para a frente e inclina para baixo', () => {
    const c = simular(new THREE.Vector3(0, 0, -0.8 * 9.81), 1.5, 0.7);
    expect(c.desloc.z).toBeGreaterThan(0.025);
    expect(c.desloc.z).toBeLessThan(0.045);
    expect(c.giro.x).toBeLessThan(0); // olha para baixo
  });
  it('curva para a direita joga a cabeça para a esquerda (+X), para fora da curva', () => {
    // centrípeta para a direita = −X no referencial do carro
    const c = simular(new THREE.Vector3(-0.6 * 9.81, 0, 0), 1.5);
    expect(c.desloc.x).toBeGreaterThan(0.015);
    expect(c.giro.z).toBeGreaterThan(0);
  });
  it('intensidade 0 deixa a câmera presa ao carro', () => {
    const c = new MovimentoCabeca();
    c.intensidade = 0;
    const rot = new THREE.Quaternion();
    for (let i = 0; i < 60; i++) c.atualizar(1 / 60, { vel: new THREE.Vector3(0, 0, i), rot, dtSim: 1 / 60, rpm: 850, rpmLenta: 850, ligado: true, cilindros: 3, carga: 0.2 });
    expect(c.desloc.length()).toBe(0);
  });
});
