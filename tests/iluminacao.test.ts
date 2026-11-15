import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FAIXAS } from '../src/world/vias';
import { lerGrade, METROS_POR_PX } from '../src/world/autoescola';
import grade from '../src/world/autoescola/grade.json';
import {
  atualizarIluminacaoPublica,
  criarIluminacaoPublica,
  definirIluminacaoPublica,
  N_LUZES,
  postesDe,
} from '../src/world/iluminacao';
import { definirLuzesNoturnas } from '../src/world/ambiente';

const g = lerGrade();
const elevado = (x: number, z: number) => {
  const xp = x / METROS_POR_PX + grade.larguraPx / 2;
  const yp = z / METROS_POR_PX + grade.alturaPx / 2;
  if (xp < 0 || yp < 0 || xp >= grade.larguraPx || yp >= grade.alturaPx) return true; // grama fora da planta
  return g[Math.floor(yp / grade.celulaPx)][Math.floor(xp / grade.celulaPx)];
};

describe('iluminação pública', () => {
  it('põe postes na calçada (fora do asfalto), espaçados, com colisor', () => {
    const grupo = criarIluminacaoPublica(FAIXAS);
    const postes = postesDe(grupo);
    expect(postes.length).toBeGreaterThanOrEqual(8);
    for (const p of postes) expect(elevado(p.pe.x, p.pe.z)).toBe(true);
    for (let i = 0; i < postes.length; i++)
      for (let j = i + 1; j < postes.length; j++) expect(postes[i].pe.distanceTo(postes[j].pe)).toBeGreaterThan(9);
    const filhos = grupo.children.filter((c) => c.name.startsWith('poste_'));
    expect(filhos.length).toBe(postes.length);
    for (const c of filhos) expect(c.userData.colisor).toMatchObject({ raio: expect.any(Number), altura: expect.any(Number) });
    // poucas luzes reais, número fixo
    expect(grupo.children.filter((c) => (c as THREE.Light).isLight).length).toBe(N_LUZES);
  });

  it('respeita evitar()', () => {
    const todos = postesDe(criarIluminacaoPublica(FAIXAS));
    const alvo = todos[0].pe;
    const sem = postesDe(criarIluminacaoPublica(FAIXAS, { evitar: (x, z) => Math.hypot(x - alvo.x, z - alvo.z) < 3 }));
    expect(sem.some((p) => p.pe.distanceTo(alvo) < 3)).toBe(false);
  });

  it('remaneja as luzes reais para os postes mais perto do carro', () => {
    const grupo = criarIluminacaoPublica(FAIXAS);
    const luzes = grupo.children.filter((c): c is THREE.SpotLight => (c as THREE.SpotLight).isSpotLight);
    definirIluminacaoPublica(grupo, false);
    atualizarIluminacaoPublica(grupo, new THREE.Vector3(), 0.5);
    expect(luzes.every((l) => l.intensity === 0 && !l.visible)).toBe(true);

    definirIluminacaoPublica(grupo, true);
    const carro = postesDe(grupo)[3].cabeca.clone().setY(0);
    for (let i = 0; i < 20; i++) atualizarIluminacaoPublica(grupo, carro, 0.1);
    const postes = postesDe(grupo);
    const perto = [...postes].sort((a, b) => a.cabeca.distanceToSquared(carro) - b.cabeca.distanceToSquared(carro));
    for (const p of perto.slice(0, N_LUZES - 1)) expect(p.luz).toBeGreaterThanOrEqual(0);
    const acesas = luzes.filter((l) => l.intensity > 0);
    expect(acesas.length).toBeLessThanOrEqual(N_LUZES);
    expect(acesas.length).toBeGreaterThanOrEqual(Math.min(postes.length, N_LUZES - 1));
    // a luz do poste mais perto está sobre ele
    const l0 = luzes.find((l) => l.position.distanceTo(perto[0].cabeca) < 1e-6);
    expect(l0?.intensity).toBeGreaterThan(0);

    // anda até o outro lado: as luzes acompanham
    const longe = perto[perto.length - 1].cabeca.clone().setY(0);
    for (let i = 0; i < 30; i++) atualizarIluminacaoPublica(grupo, longe, 0.1);
    const l1 = luzes.find((l) => l.position.distanceTo(perto[perto.length - 1].cabeca) < 1e-6);
    expect(l1?.intensity).toBeGreaterThan(0);
  });

  it('acende junto com as luzes noturnas globais', () => {
    definirLuzesNoturnas(0, 0);
    const grupo = criarIluminacaoPublica(FAIXAS);
    const pocas = grupo.getObjectByName('pocasDeLuz')!;
    expect(pocas.visible).toBe(false);
    definirLuzesNoturnas(1, 1);
    expect(pocas.visible).toBe(true);
    const lente = (grupo.getObjectByName('poste_0')!.userData.lampada as THREE.MeshStandardMaterial);
    expect(lente.emissiveIntensity).toBeGreaterThan(0);
    definirLuzesNoturnas(0, 0);
    expect(pocas.visible).toBe(false);
    expect(lente.emissiveIntensity).toBe(0);
  });
});
