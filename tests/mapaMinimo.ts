import * as THREE from 'three';

/**
 * Mapa mínimo só para os testes: chão plano grande, uma calçada, uma vaga de
 * baliza com 4 hastes, 2 cones, faixa de pedestres, semáforo com linha de
 * retenção, uma zona de rampa e o spawn apontando para +X. Usa as mesmas
 * convenções de nome do parser (COL_, BALIZA_, CONE_, ZONA_, …).
 */
export function criarMapaMinimo(): THREE.Group {
  const raiz = new THREE.Group();
  const caixa = (nome: string, sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz));
    m.name = nome;
    m.position.set(x, y, z);
    raiz.add(m);
    return m;
  };
  caixa('COL_chao', 400, 1, 400, 0, -0.5, 0);
  // calçada ao longo de z = 4..6.5 (à direita de quem anda para +X)
  caixa('COL_calcada_1', 120, 0.15, 2.5, 0, 0.075, 5.25);
  // vaga da baliza à frente, encostada na calçada (longe do caminho de saída)
  caixa('ZONA_BALIZA', 5.2, 2, 2.2, 40, 1, 2.8);
  let n = 1;
  for (const dx of [-2.6, 2.6]) for (const dz of [-1.1, 1.0]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 8));
    b.name = `BALIZA_${n++}`;
    b.position.set(40 + dx, 0.7, 2.8 + dz);
    raiz.add(b);
  }
  for (const dx of [-7, 7]) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.5, 10));
    c.name = `CONE_${n++}`;
    c.position.set(40 + dx, 0.25, 2.8);
    raiz.add(c);
  }
  caixa('FAIXA_PEDESTRE_1', 3, 2, 7, 80, 1, 0);
  caixa('LINHA_PARADA_1', 0.6, 2, 3.5, 76, 1, 1.75);
  const poste = caixa('SEMAFORO_1', 0.15, 3.2, 0.15, 76.5, 1.75, 4.1);
  poste.userData = { verde: 12, amarelo: 3, vermelho: 10 };
  caixa('ZONA_RAMPA', 10, 3, 7, 120, 1, 0);
  const spawn = new THREE.Object3D();
  spawn.name = 'SPAWN_CARRO';
  spawn.position.set(-40, 0, 2.4);
  spawn.rotation.y = -Math.PI / 2; // −Z local → +X mundo
  raiz.add(spawn);
  return raiz;
}
