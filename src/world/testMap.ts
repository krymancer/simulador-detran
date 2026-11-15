import * as THREE from 'three';

/**
 * Mapa de teste montado por código, usando exatamente as mesmas convenções de
 * nome que um GLB vindo do Blender (ver parser.ts). Serve de exemplo de como
 * montar o seu mapa.
 *
 * Planta (vista de cima, X para a direita, Z para baixo):
 *
 *   calçada  ───────────────────────────────────────────────────────────
 *   pista      [SPAWN →]   [vaga baliza]      [ rampa ↗ ▭ ↘ ]   |faixa| ▲semáforo
 *   calçada  ───────────────────────────────────────────────────────────
 */

const mat = (cor: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color: cor, roughness: 0.9, flatShading: true, ...extra });

const M = {
  asfalto: mat(0x3a3d42),
  grama: mat(0x5d8a4a),
  calcada: mat(0xb9b4a8),
  meiofio: mat(0xd9d4c8),
  faixa: mat(0xf2f2f2),
  amarelo: mat(0xf2c230),
  baliza: mat(0xff7a00),
  cone: mat(0xff5a1f),
  poste: mat(0x2b2b2b),
  rampa: mat(0x55585e),
  predio: [mat(0xd9c9a8), mat(0xa9b8c9), mat(0xc9a9a9), mat(0xb5c9a9), mat(0xe0e0e0)],
};

function caixa(nome: string, sx: number, sy: number, sz: number, material: THREE.Material, visivelColisor = true): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
  m.name = nome;
  m.castShadow = true;
  m.receiveShadow = true;
  if (nome.startsWith('COL_')) m.userData.visivel = visivelColisor;
  return m;
}

export function criarMapaTeste(): THREE.Group {
  const raiz = new THREE.Group();
  raiz.name = 'mapa_teste';

  const LARG_PISTA = 3.5; // por faixa
  const X0 = -60;
  const X1 = 60;

  // Chão (grama) e pista (asfalto) — ambos colisores visíveis.
  const grama = caixa('COL_grama', 260, 1, 160, M.grama);
  grama.position.set(0, -0.52, 0);
  raiz.add(grama);

  const pista = caixa('COL_pista', X1 - X0 + 40, 1, LARG_PISTA * 2, M.asfalto);
  pista.position.set(0, -0.5, 0);
  raiz.add(pista);

  // Praça de retorno no fim da pista
  const praca = caixa('COL_praca', 30, 1, 40, M.asfalto);
  praca.position.set(X1 + 25, -0.5, 0);
  raiz.add(praca);
  const praca2 = caixa('COL_praca_ini', 30, 1, 40, M.asfalto);
  praca2.position.set(X0 - 25, -0.5, 0);
  raiz.add(praca2);

  // Rampa: sobe 15% por 10 m, platô de 6 m, desce 10 m. Ocupa as duas faixas.
  const inclin = Math.atan(0.15);
  const comp = 10;
  const altura = comp * 0.15;
  const xRampa = 14;
  const rampaGrupo = new THREE.Group();
  rampaGrupo.name = 'rampa';
  const sobe = caixa('COL_rampa_sobe', comp / Math.cos(inclin), 0.6, LARG_PISTA * 2, M.rampa);
  sobe.rotation.z = inclin;
  sobe.position.set(xRampa + comp / 2, altura / 2 - 0.3 / Math.cos(inclin), 0);
  const plato = caixa('COL_rampa_plato', 6, 0.6, LARG_PISTA * 2, M.rampa);
  plato.position.set(xRampa + comp + 3, altura - 0.3, 0);
  const desce = caixa('COL_rampa_desce', comp / Math.cos(inclin), 0.6, LARG_PISTA * 2, M.rampa);
  desce.rotation.z = -inclin;
  desce.position.set(xRampa + comp + 6 + comp / 2, altura / 2 - 0.3 / Math.cos(inclin), 0);
  rampaGrupo.add(sobe, plato, desce);
  raiz.add(rampaGrupo);
  // Zona da rampa: o trecho de subida (é onde o examinador manda parar).
  const zonaRampa = caixa('ZONA_RAMPA', comp, 3, LARG_PISTA * 2, M.faixa);
  zonaRampa.position.set(xRampa + comp / 2, altura / 2 + 1, 0);
  raiz.add(zonaRampa);
  const xFimRampa = xRampa + 2 * comp + 6;

  // Calçadas (meio-fio de 15 cm) dos dois lados, interrompidas na rampa.
  const trechos: [number, number][] = [[X0, xRampa - 1], [xFimRampa + 1, X1]];
  for (const lado of [1, -1]) {
    for (const [a, b] of trechos) {
      const c = caixa(`COL_calcada_${lado > 0 ? 'dir' : 'esq'}_${a}`, b - a, 0.15, 2.5, M.calcada);
      c.position.set((a + b) / 2, 0.075, lado * (LARG_PISTA + 1.25));
      raiz.add(c);
    }
  }

  // Marcas: linha central tracejada amarela e bordas brancas (só visual).
  for (let x = X0; x < X1; x += 6) {
    if (x > xRampa - 1 && x < xFimRampa + 1) continue;
    const t = new THREE.Mesh(new THREE.PlaneGeometry(3, 0.12), M.amarelo);
    t.rotation.x = -Math.PI / 2;
    t.position.set(x + 1.5, 0.005, 0);
    t.receiveShadow = true;
    raiz.add(t);
  }

  // Vaga da baliza junto à calçada direita (lado +Z).
  // Comprimento ≈ carro + 40%, largura ≈ carro + 40%  (3,68 × 1,4 ≈ 5,2 m; 1,58 × 1,4 ≈ 2,2 m)
  const vagaComp = 5.2;
  const vagaLarg = 2.2;
  const xVaga = -18;
  const zVaga = LARG_PISTA - vagaLarg / 2;
  const zona = caixa('ZONA_BALIZA', vagaComp, 2, vagaLarg, M.faixa);
  zona.position.set(xVaga, 1, zVaga);
  raiz.add(zona);
  // Pintura da vaga
  for (const [dx, dz, sx, sz] of [
    [-vagaComp / 2, 0, 0.1, vagaLarg], [vagaComp / 2, 0, 0.1, vagaLarg], [0, -vagaLarg / 2, vagaComp, 0.1],
  ] as const) {
    const l = new THREE.Mesh(new THREE.PlaneGeometry(sx, sz), M.faixa);
    l.rotation.x = -Math.PI / 2;
    l.position.set(xVaga + dx, 0.006, zVaga + dz);
    raiz.add(l);
  }
  // Balizas nos 4 cantos
  let n = 1;
  for (const dx of [-vagaComp / 2, vagaComp / 2]) {
    for (const dz of [-vagaLarg / 2, vagaLarg / 2 - 0.1]) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 8), M.baliza);
      b.name = `BALIZA_${n++}`;
      b.position.set(xVaga + dx, 0.7, zVaga + dz);
      b.castShadow = true;
      raiz.add(b);
    }
  }
  // Cones delimitando os “carros” estacionados na frente e atrás da vaga
  for (const dx of [-vagaComp / 2 - 4, vagaComp / 2 + 4]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.5, 10), M.cone);
    cone.name = `CONE_${n++}`;
    cone.position.set(xVaga + dx, 0.25, zVaga);
    cone.castShadow = true;
    raiz.add(cone);
  }

  // Semáforo, linha de retenção e faixa de pedestres depois da rampa (faixa da direita).
  const xLinha = xFimRampa + 10;
  const linha = new THREE.Mesh(new THREE.PlaneGeometry(0.4, LARG_PISTA), M.faixa);
  linha.rotation.x = -Math.PI / 2;
  linha.position.set(xLinha, 0.006, LARG_PISTA / 2);
  raiz.add(linha);
  const zLinha = caixa('LINHA_PARADA_1', 0.6, 2, LARG_PISTA, M.faixa);
  zLinha.position.set(xLinha + 0.3, 1, LARG_PISTA / 2);
  raiz.add(zLinha);

  const xFaixa = xLinha + 1.5;
  for (let z = -LARG_PISTA + 0.3; z < LARG_PISTA; z += 0.9) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(3, 0.45), M.faixa);
    f.rotation.x = -Math.PI / 2;
    f.position.set(xFaixa + 1.5, 0.006, z + 0.2);
    raiz.add(f);
  }
  const zFaixa = caixa('FAIXA_PEDESTRE_1', 3, 2, LARG_PISTA * 2, M.faixa);
  zFaixa.position.set(xFaixa + 1.5, 1, 0);
  raiz.add(zFaixa);

  const poste = caixa('SEMAFORO_1', 0.15, 3.2, 0.15, M.poste);
  poste.position.set(xLinha + 0.5, 1.6 + 0.15, LARG_PISTA + 0.6);
  poste.userData = { verde: 12, amarelo: 3, vermelho: 10 };
  raiz.add(poste);

  // Prédios low-poly (só cenário)
  let i = 0;
  for (let x = X0; x < X1; x += 9) {
    for (const lado of [1, -1]) {
      if (x > xRampa - 6 && x < xFimRampa + 4 && lado < 0) continue;
      const h = 4 + ((i * 37) % 9);
      const p = new THREE.Mesh(new THREE.BoxGeometry(7, h, 6), M.predio[i % M.predio.length]);
      p.position.set(x + 4, h / 2, lado * (LARG_PISTA + 2.5 + 3 + 1));
      p.castShadow = true;
      p.receiveShadow = true;
      raiz.add(p);
      i++;
    }
  }

  // Spawn: estacionado na faixa da direita, junto ao meio-fio, apontando para +X.
  // O carro aponta para −Z local do objeto (= +Y do Blender).
  const spawn = new THREE.Object3D();
  spawn.name = 'SPAWN_CARRO';
  spawn.position.set(-45, 0, LARG_PISTA - 1.1);
  spawn.rotation.y = -Math.PI / 2; // −Z local → +X mundo
  raiz.add(spawn);

  return raiz;
}
