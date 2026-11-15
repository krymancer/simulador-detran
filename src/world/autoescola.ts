import * as THREE from 'three';
import grade from './autoescola/grade.json';

/**
 * Pista da autoescola, gerada a partir da planta (imagem vista de cima) por
 * `scripts/gerar-mapa.mjs`: a textura do chão é a própria planta limpa, e a
 * grade diz onde há calçada/canteiro (15 cm acima do asfalto, com meio-fio).
 *
 * Coordenadas: 1 px da planta = 1/23 m. X da imagem → +X do mundo; Y da imagem → +Z.
 * Este módulo não usa DOM (roda nos testes). As placas e o cenário entram em
 * `autoescolaDecoracao.ts`.
 */

export const METROS_POR_PX = 1 / 23;
export const ALTURA_CALCADA = 0.15;

const W = grade.larguraPx;
const H = grade.alturaPx;
const C = grade.celulaPx;

/** Planta (px) → mundo (m), no nível do asfalto. */
export function px(x: number, y: number, alt = 0): THREE.Vector3 {
  return new THREE.Vector3((x - W / 2) * METROS_POR_PX, alt, (y - H / 2) * METROS_POR_PX);
}

// ---------------------------------------------------------------- relevo
/**
 * Rampa na reta da direita do anel (mão dupla): sobe ~0,9 m em 9 m (≈10% de
 * média, 15% no meio), platô de 6 m e desce do outro lado. Fora dela, tudo plano.
 * O perfil é em cosseno (sem quinas que batam o para-choque).
 */
export const RAMPA = {
  yCentroPx: 700,
  platoM: 3,       // meio comprimento do platô
  rampaM: 9,       // comprimento de cada subida
  alturaM: 0.9,
  // faixa em X (px da planta) onde o relevo vale, com transição linear nas bordas
  xIni: 1265, xCheio: 1355, xCheioFim: 1525, xFim: 1600,
};

/** Altura do terreno (m) no ponto (x, z) do mundo — 0 fora da rampa. */
export function alturaTerreno(x: number, z: number): number {
  const xp = x / METROS_POR_PX + W / 2;
  let fx: number;
  if (xp <= RAMPA.xIni || xp >= RAMPA.xFim) return 0;
  if (xp < RAMPA.xCheio) fx = (xp - RAMPA.xIni) / (RAMPA.xCheio - RAMPA.xIni);
  else if (xp <= RAMPA.xCheioFim) fx = 1;
  else fx = (RAMPA.xFim - xp) / (RAMPA.xFim - RAMPA.xCheioFim);
  const zc = (RAMPA.yCentroPx - H / 2) * METROS_POR_PX;
  const d = Math.abs(z - zc);
  if (d >= RAMPA.platoM + RAMPA.rampaM) return 0;
  const fz = d <= RAMPA.platoM ? 1 : 0.5 * (1 + Math.cos((Math.PI * (d - RAMPA.platoM)) / RAMPA.rampaM));
  return RAMPA.alturaM * fx * fz;
}

/** Linhas da grade (células) que ficam na rampa — ali a geometria é mais fina. */
function linhaNaRampa(gy: number): boolean {
  const meio = (RAMPA.platoM + RAMPA.rampaM) / METROS_POR_PX + C;
  const ypx = (gy + 0.5) * C;
  return Math.abs(ypx - RAMPA.yCentroPx) < meio;
}
/** Colunas onde a inclinação lateral muda (cortes dos retângulos). */
const CORTES_X = [RAMPA.xIni, RAMPA.xCheio, RAMPA.xCheioFim, RAMPA.xFim].map((x) => Math.round(x / C));

/** Grade de colisão: true = calçada/canteiro. */
export function lerGrade(): boolean[][] {
  return grade.dados.map((linha: string) => {
    const a = linha.split(',').map(Number);
    const out: boolean[] = [];
    for (let i = 0; i < a.length; i += 2) for (let k = 0; k < a[i + 1]; k++) out.push(a[i] === 1);
    return out;
  });
}

/** Junta células elevadas em retângulos (menos triângulos). */
function retangulos(g: boolean[][]): { x0: number; x1: number; y0: number; y1: number }[] {
  const out: { x0: number; x1: number; y0: number; y1: number }[] = [];
  let abertos = new Map<string, { x0: number; x1: number; y0: number; y1: number }>();
  for (let y = 0; y < g.length; y++) {
    const runs: [number, number][] = [];
    const rampa = linhaNaRampa(y);
    let x = 0;
    while (x < g[y].length) {
      if (!g[y][x]) { x++; continue; }
      const ini = x;
      while (x < g[y].length && g[y][x] && !(rampa && x > ini && CORTES_X.includes(x))) x++;
      runs.push([ini, x]);
    }
    const novos = new Map<string, { x0: number; x1: number; y0: number; y1: number }>();
    for (const [a, b] of runs) {
      // na rampa cada linha é um retângulo próprio (o relevo muda ao longo de Z)
      const k = rampa ? `r${y},${a},${b}` : `${a},${b}`;
      const r = abertos.get(k);
      if (r) { r.y1 = y + 1; novos.set(k, r); abertos.delete(k); }
      else novos.set(k, { x0: a, x1: b, y0: y, y1: y + 1 });
    }
    for (const r of abertos.values()) out.push(r);
    abertos = novos;
  }
  for (const r of abertos.values()) out.push(r);
  return out;
}

/** Geometria das calçadas: topos (grupo 0, com UV da planta) + laterais do meio-fio (grupo 1). */
function geometriaCalcadas(g: boolean[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const nor: number[] = [];
  const idxTopo: number[] = [];
  const idxLado: number[] = [];
  const h = ALTURA_CALCADA;
  const s = METROS_POR_PX * C;
  const ox = -(W / 2) * METROS_POR_PX;
  const oz = -(H / 2) * METROS_POR_PX;
  const elev = (cx: number, cy: number) => cy >= 0 && cy < g.length && cx >= 0 && cx < g[0].length && g[cy][cx];

  const quad = (pts: number[][], n: number[], alvo: number[]) => {
    const b = pos.length / 3;
    for (const p of pts) {
      pos.push(p[0], p[1] + alturaTerreno(p[0], p[2]), p[2]);
      nor.push(n[0], n[1], n[2]);
      uv.push((p[0] - ox) / (W * METROS_POR_PX), 1 - (p[2] - oz) / (H * METROS_POR_PX));
    }
    alvo.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };

  for (const r of retangulos(g)) {
    const x0 = ox + r.x0 * s, x1 = ox + r.x1 * s, z0 = oz + r.y0 * s, z1 = oz + r.y1 * s;
    quad([[x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0]], [0, 1, 0], idxTopo);
    // Laterais só onde o vizinho é asfalto (é o meio-fio de verdade).
    for (let cy = r.y0; cy < r.y1; cy++) {
      const za = oz + cy * s, zb = za + s;
      if (!elev(r.x0 - 1, cy)) quad([[x0, 0, za], [x0, 0, zb], [x0, h, zb], [x0, h, za]], [-1, 0, 0], idxLado);
      if (!elev(r.x1, cy)) quad([[x1, 0, zb], [x1, 0, za], [x1, h, za], [x1, h, zb]], [1, 0, 0], idxLado);
    }
    for (let cx = r.x0; cx < r.x1; cx++) {
      const xa = ox + cx * s, xb = xa + s;
      if (!elev(cx, r.y0 - 1)) quad([[xb, 0, z0], [xa, 0, z0], [xa, h, z0], [xb, h, z0]], [0, 0, -1], idxLado);
      if (!elev(cx, r.y1)) quad([[xa, 0, z1], [xb, 0, z1], [xb, h, z1], [xa, h, z1]], [0, 0, 1], idxLado);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex([...idxTopo, ...idxLado]);
  geo.addGroup(0, idxTopo.length, 0);
  geo.addGroup(idxTopo.length, idxLado.length, 1);
  return geo;
}

function caixaZona(nome: string, centro: THREE.Vector3, larg: number, comp: number, yaw: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(larg, 2.5, comp), new THREE.MeshBasicMaterial({ visible: false }));
  m.name = nome;
  m.position.copy(centro).setY(1);
  m.rotation.y = yaw;
  return m;
}

/** Zona retangular a partir de 4 cantos aproximados na planta (px): centro, tamanho e direção. */
function zonaPorCantos(nome: string, a: [number, number], b: [number, number], larguraPx: number): THREE.Mesh {
  // a → b é o eixo comprido (ao longo da via); larguraPx é a largura transversal
  const pa = px(...a);
  const pb = px(...b);
  const centro = pa.clone().add(pb).multiplyScalar(0.5);
  const dir = pb.clone().sub(pa);
  const yaw = Math.atan2(dir.x, dir.z);
  return caixaZona(nome, centro, larguraPx * METROS_POR_PX, dir.length(), yaw);
}

export interface OpcoesAutoescola {
  /** Textura do chão (chao.png). Sem ela (testes), usa cor lisa. */
  textura?: THREE.Texture;
}

export function criarMapaAutoescola(op: OpcoesAutoescola = {}): THREE.Group {
  const raiz = new THREE.Group();
  raiz.name = 'autoescola';
  const g = lerGrade();
  const largM = W * METROS_POR_PX;
  const altM = H * METROS_POR_PX;

  const matChao = new THREE.MeshStandardMaterial({ map: op.textura ?? null, color: op.textura ? 0xffffff : 0x3c3c3c, roughness: 0.92 });
  const matMeioFio = new THREE.MeshStandardMaterial({ color: 0xb8b3a8, roughness: 0.85 });

  // Asfalto: um plano com a planta inteira como textura.
  const geoAsfalto = new THREE.PlaneGeometry(largM, altM, Math.round(largM / 0.5), Math.round(altM / 0.5));
  {
    // o plano está em XY e é girado −90° em X: z do mundo = −y local; o relevo vai em z local
    const pa = geoAsfalto.getAttribute('position');
    for (let i = 0; i < pa.count; i++) pa.setZ(i, alturaTerreno(pa.getX(i), -pa.getY(i)));
    geoAsfalto.computeVertexNormals();
  }
  const asfalto = new THREE.Mesh(geoAsfalto, matChao);
  asfalto.rotation.x = -Math.PI / 2;
  asfalto.name = 'COL_pista';
  asfalto.userData.visivel = true;
  asfalto.receiveShadow = true;
  raiz.add(asfalto);

  // Calçadas / canteiros com meio-fio
  const calcadas = new THREE.Mesh(geometriaCalcadas(g), [matChao, matMeioFio]);
  calcadas.name = 'COL_calcada';
  calcadas.userData.visivel = true;
  calcadas.receiveShadow = true;
  calcadas.castShadow = true;
  raiz.add(calcadas);

  // Gramado em volta da planta (mesma altura da calçada)
  const matGrama = new THREE.MeshStandardMaterial({ color: 0x5f8a4c, roughness: 1 });
  const borda = 160;
  const faixas: [number, number, number, number][] = [
    [0, -(altM / 2 + borda / 2), largM + 2 * borda, borda],
    [0, altM / 2 + borda / 2, largM + 2 * borda, borda],
    [-(largM / 2 + borda / 2), 0, borda, altM],
    [largM / 2 + borda / 2, 0, borda, altM],
  ];
  faixas.forEach(([x, z, sx, sz], i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 1, sz), matGrama);
    m.position.set(x, ALTURA_CALCADA - 0.5, z);
    m.name = `COL_calcada_grama_${i}`;
    m.userData.visivel = true;
    m.receiveShadow = true;
    raiz.add(m);
  });

  // ---- Baliza: faixa interna do lado esquerdo, entre a linha amarela (y≈697) e a cinza (y≈815).
  // A vaga tem ~5,1 m; as hastes ficam a ~2,4 m uma da outra, encostadas no meio-fio.
  const yTopo = 697, yBase = 813;
  const xMeioFio = (y: number) => 234 + ((y - 700) / 115) * 4;
  const largVagaPx = 2.4 / METROS_POR_PX;
  const cantos: [number, number][] = [
    [xMeioFio(yTopo) - 6, yTopo + 4], [xMeioFio(yTopo) - 6 - largVagaPx, yTopo + 4],
    [xMeioFio(yBase) - 6, yBase - 4], [xMeioFio(yBase) - 6 - largVagaPx, yBase - 4],
  ];
  const matBaliza = new THREE.MeshStandardMaterial({ color: 0xff7a00, roughness: 0.5 });
  const matFaixaBaliza = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.5 });
  cantos.forEach(([x, y], i) => {
    const haste = new THREE.Group();
    haste.name = `BALIZA_${i + 1}`;
    const tubo = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 10), matBaliza);
    tubo.position.y = 0.75;
    // faixas refletivas
    for (const yy of [0.5, 0.9, 1.25]) {
      const f = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.08, 10), matFaixaBaliza);
      f.position.y = yy;
      haste.add(f);
    }
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.1, 14), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    base.position.y = 0.05;
    haste.add(tubo, base);
    haste.position.copy(px(x, y));
    haste.traverse((o) => { o.castShadow = true; });
    raiz.add(haste);
  });
  const centroTopo: [number, number] = [xMeioFio(yTopo) - 6 - largVagaPx / 2, yTopo];
  const centroBase: [number, number] = [xMeioFio(yBase) - 6 - largVagaPx / 2, yBase];
  raiz.add(zonaPorCantos('ZONA_BALIZA', centroTopo, centroBase, largVagaPx + 8));

  // ---- Faixas de pedestres (zebras da planta)
  raiz.add(zonaPorCantos('FAIXA_PEDESTRE_1', [531, 22], [531, 175], 64));
  raiz.add(zonaPorCantos('FAIXA_PEDESTRE_2', [850, 22], [850, 175], 66));
  raiz.add(zonaPorCantos('FAIXA_PEDESTRE_3', [610, 215], [800, 215], 62));

  // ---- Cruzamento de cima com SEMÁFORO (fases: rua de cima × avenida).
  // Linhas de retenção: caixas finas com +Z no sentido do trânsito.
  raiz.add(zonaPorCantos('LINHA_PARADA_1', [729, 278], [723, 262], 178)); // avenida, subindo
  raiz.add(zonaPorCantos('LINHA_PARADA_2', [902, 56], [886, 56], 74));    // faixa de cima à direita, indo para oeste
  raiz.add(zonaPorCantos('LINHA_PARADA_3', [469, 137], [485, 137], 78));  // faixa interna à esquerda, indo para leste
  const semaforos: { id: number; x: number; y: number; face: [number, number]; fase: 'rua' | 'avenida' }[] = [
    { id: 1, x: 845, y: 270, face: [0.38, 0.92], fase: 'avenida' },
    { id: 2, x: 895, y: -14, face: [1, 0], fase: 'rua' },
    { id: 3, x: 470, y: 192, face: [-1, 0], fase: 'rua' },
  ];
  const matPoste = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6, metalness: 0.4 });
  for (const sm of semaforos) {
    let [x, y] = [sm.x, sm.y];
    // empurra para a calçada se cair no asfalto
    const gy = Math.floor(y / C), gx = Math.floor(x / C);
    if (gy >= 0 && gy < g.length && !g[gy]?.[gx]) {
      for (let r = 4; r < 60; r += 4) {
        const ok = [[r, 0], [-r, 0], [0, r], [0, -r]].find(([dx, dy]) => g[Math.floor((y + dy) / C)]?.[Math.floor((x + dx) / C)]);
        if (ok) { x += ok[0]; y += ok[1]; break; }
      }
    }
    const poste = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 3.3, 10), matPoste);
    poste.name = `SEMAFORO_${sm.id}`;
    const base = px(x, y, ALTURA_CALCADA);
    poste.position.set(base.x, base.y + 1.65, base.z);
    poste.rotation.y = Math.atan2(sm.face[0], sm.face[1]);
    poste.castShadow = true;
    // Ciclo de 35 s: rua verde 0–15, amarela 15–18, vermelho total 18–20; avenida verde 20–32, amarela 32–35.
    poste.userData = sm.fase === 'rua'
      ? { verde: 15, amarelo: 3, vermelho: 17, defasagem: 0 }
      : { verde: 12, amarelo: 3, vermelho: 20, defasagem: 15 };
    raiz.add(poste);
  }

  // ---- Parada obrigatória (PARE) na saída do estacionamento (sentido norte).
  raiz.add(zonaPorCantos('ZONA_PARE_3', [1232, 1400], [1232, 1356], 625));

  // ---- Passagem de nível (linha férrea em x ≈ 676): parada obrigatória antes dos trilhos (CTB art. 212).
  // As zonas terminam ANTES das cancelas (que ficam a ±4,3 m da linha), não na pintura.
  raiz.add(zonaPorCantos('ZONA_PARE_PN_1', [500, 1312], [574, 1312], 76)); // faixa de baixo, indo para leste
  raiz.add(zonaPorCantos('ZONA_PARE_PN_2', [856, 1232], [782, 1232], 76)); // faixa de cima, indo para oeste

  // ---- Rampa (reta da direita): zonas da subida em cada sentido.
  const platoPx = RAMPA.platoM / METROS_POR_PX;
  const rampaPx = RAMPA.rampaM / METROS_POR_PX;
  raiz.add(zonaPorCantos('ZONA_RAMPA_1', [1440, RAMPA.yCentroPx + platoPx + rampaPx], [1440, RAMPA.yCentroPx + platoPx], 165)); // subindo para o norte
  raiz.add(zonaPorCantos('ZONA_RAMPA_2', [1440, RAMPA.yCentroPx - platoPx - rampaPx], [1440, RAMPA.yCentroPx - platoPx], 165)); // subindo para o sul

  // ---- Spawn: estacionado numa vaga do estacionamento de baixo, de frente para a rua (norte = −Z).
  const spawn = new THREE.Object3D();
  spawn.name = 'SPAWN_CARRO';
  spawn.position.copy(px(1100, 1462));
  // sem rotação: o carro aponta para −Z local (= norte da planta)
  raiz.add(spawn);

  return raiz;
}
