// Cenário procedural reutilizável: árvores, prédios/casas, postes de
// iluminação, muros e o céu (Sky físico + sol com sombra + névoa no horizonte).
//
// Nada de assets baixados: geometria gerada e texturas em CanvasTexture.
// Unidades em metros, +Y para cima. Materiais e texturas são compartilhados
// (cache) para manter as chamadas de desenho e a memória baixas.

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** Gerador pseudoaleatório determinístico (mulberry32). */
function rng(semente: number): () => number {
  let a = (Math.floor(semente) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const entre = (r: () => number, a: number, b: number) => a + (b - a) * r();

/** Ruído suave barato (soma de senos) — contínuo, então vértices duplicados coincidem. */
function ruido3(x: number, y: number, z: number, s: number): number {
  return (
    Math.sin(x * 1.7 + s) * Math.sin(y * 2.1 + s * 1.3) * Math.sin(z * 1.9 + s * 0.7) +
    0.5 * Math.sin(x * 3.9 - s * 0.6 + z * 1.3) * Math.sin(y * 4.3 + s * 2.1 - x * 0.7) +
    0.25 * Math.sin(z * 7.1 + s * 1.7 + y * 2.2) * Math.sin(x * 6.7 - s)
  );
}

function novaTela(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d')! };
}

function texturaDe(canvas: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function sombra<T extends THREE.Object3D>(o: T, projeta = true, recebe = true): T {
  o.castShadow = projeta;
  o.receiveShadow = recebe;
  return o;
}

// ---------------------------------------------------------------------------
// Árvores
// ---------------------------------------------------------------------------

let _texFolhas: THREE.CanvasTexture | null = null;
let _texFolhasDensa: THREE.CanvasTexture | null = null;

/**
 * Textura de "tufo de folhas" em tons de cinza (tingida pela cor do vértice).
 * `densa`: fundo escuro opaco, folhas por toda parte (miolo da copa).
 */
function texturaFolhas(densa = false): THREE.CanvasTexture {
  if (densa && _texFolhasDensa) return _texFolhasDensa;
  if (!densa && _texFolhas) return _texFolhas;
  const N = 256;
  const { canvas, ctx } = novaTela(N, N);
  const r = rng(densa ? 777 : 4242);
  ctx.clearRect(0, 0, N, N);
  if (densa) {
    ctx.fillStyle = 'rgb(70,70,70)';
    ctx.fillRect(0, 0, N, N);
  }
  for (let i = 0; i < (densa ? 900 : 700); i++) {
    const x = r() * N;
    const y = r() * N;
    // mais denso no centro do ladrilho, buracos nas bordas
    const dc = Math.hypot(x - N / 2, y - N / 2) / (N / 2);
    if (!densa && (dc > 0.98 || r() < THREE.MathUtils.smoothstep(dc, 0.45, 0.95))) continue;
    const comp = entre(r, 9, 20);
    const l = Math.round(entre(r, 150, 255));
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(r() * Math.PI * 2);
    ctx.fillStyle = `rgb(${l},${l},${l})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, comp, comp * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    // nervura central mais escura
    ctx.strokeStyle = `rgba(0,0,0,0.18)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-comp * 0.9, 0);
    ctx.lineTo(comp * 0.9, 0);
    ctx.stroke();
    ctx.restore();
  }
  const t = texturaDe(canvas);
  if (densa) return (_texFolhasDensa = t);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return (_texFolhas = t);
}

let _matTronco: THREE.MeshStandardMaterial | null = null;
let _matFolhaInt: THREE.MeshStandardMaterial | null = null;
let _matFolhaExt: THREE.MeshStandardMaterial | null = null;

function materiaisArvore() {
  if (!_matTronco) {
    _matTronco = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    _matFolhaInt = new THREE.MeshStandardMaterial({ vertexColors: true, map: texturaFolhas(true), roughness: 0.9, metalness: 0 });
    _matFolhaExt = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: texturaFolhas(),
      alphaTest: 0.45,
      side: THREE.DoubleSide,
      roughness: 0.82,
      metalness: 0,
    });
  }
  return { tronco: _matTronco!, int: _matFolhaInt!, ext: _matFolhaExt! };
}

interface GeoArvore {
  tronco: THREE.BufferGeometry;
  folhasInt: THREE.BufferGeometry;
  folhasExt: THREE.BufferGeometry;
  raioTronco: number;
  alturaTronco: number;
}

/**
 * Deforma um aglomerado de folhagem (geometria não indexada) e grava cor,
 * normal "de copa" (suave, coerente na árvore inteira) e UV por face.
 */
function prepararAglomerado(
  g: THREE.BufferGeometry,
  centro: THREE.Vector3,
  raio: THREE.Vector3,
  copaCentro: THREE.Vector3,
  copaRaio: THREE.Vector3,
  corBase: THREE.Color,
  escuro: number,
  s: number,
  r: () => number,
  comUV: 'rala' | 'densa',
): THREE.BufferGeometry {
  const pos = g.attributes.position;
  const n = pos.count;
  const nor = new Float32Array(n * 3);
  const cor = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i); // esfera unitária
    const d = 1 + 0.22 * ruido3(v.x * 1.6, v.y * 1.6, v.z * 1.6, s);
    v.set(v.x * raio.x * d, v.y * raio.y * d, v.z * raio.z * d).add(centro);
    pos.setXYZ(i, v.x, v.y, v.z);
    a.copy(v).sub(centro).divide(raio);
    b.copy(v).sub(copaCentro).divide(copaRaio);
    a.normalize().multiplyScalar(0.45).add(b.normalize().multiplyScalar(0.55)).normalize();
    nor[i * 3] = a.x;
    nor[i * 3 + 1] = a.y;
    nor[i * 3 + 2] = a.z;
    // oclusão: mais escuro embaixo e no miolo, mais claro no topo/exterior
    const alt = THREE.MathUtils.clamp((v.y - copaCentro.y) / copaRaio.y, -1, 1);
    const ext = THREE.MathUtils.clamp(b.set(v.x - copaCentro.x, 0, v.z - copaCentro.z).length() / copaRaio.x, 0, 1.2);
    const f = escuro * (0.5 + 0.32 * (alt * 0.5 + 0.5) + 0.22 * ext) * (0.93 + 0.14 * r());
    cor[i * 3] = corBase.r * f;
    cor[i * 3 + 1] = corBase.g * f;
    cor[i * 3 + 2] = corBase.b * f;
  }
  pos.needsUpdate = true;
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(cor, 3));
  {
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i += 3) {
      // cada triângulo recebe um pedaço aleatório do ladrilho de folhas
      // triângulo inscrito num círculo maior que o tufo: bordas caem na
      // região rala da textura → silhueta recortada, não poligonal
      const ox = 0.5 + entre(r, -0.04, 0.04);
      const oy = 0.5 + entre(r, -0.04, 0.04);
      const k = comUV === 'densa' ? entre(r, 0.25, 0.4) : entre(r, 0.82, 0.95);
      const rot = r() * Math.PI * 2;
      for (let j = 0; j < 3; j++) {
        const ang = rot + (j * 2 * Math.PI) / 3;
        uv[(i + j) * 2] = ox + k * Math.cos(ang);
        uv[(i + j) * 2 + 1] = oy + k * Math.sin(ang);
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  return g;
}

function troncoGeo(
  base: THREE.Vector3,
  topo: THREE.Vector3,
  rBase: number,
  rTopo: number,
  cor: THREE.Color,
  r: () => number,
  segRad = 7,
  alargarBase = false,
): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(topo, base);
  const comp = dir.length();
  const g = new THREE.CylinderGeometry(rTopo, rBase, comp, segRad, 4, true);
  g.translate(0, comp / 2, 0);
  const pos = g.attributes.position;
  const s = r() * 10;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = y / comp;
    let k = 1 + 0.12 * Math.sin(Math.atan2(pos.getZ(i), pos.getX(i)) * 3 + s);
    if (alargarBase && t < 0.12) k *= 1 + (0.12 - t) * 3.2; // raízes
    pos.setX(i, pos.getX(i) * k + Math.sin(t * 2.4 + s) * 0.04 * comp * t);
    pos.setZ(i, pos.getZ(i) * k + Math.cos(t * 1.9 + s) * 0.03 * comp * t);
  }
  g.computeVertexNormals();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.applyQuaternion(q);
  g.translate(base.x, base.y, base.z);
  g.deleteAttribute('uv');
  const ng = g.toNonIndexed();
  g.dispose();
  // casca com leve variação vertical
  const n = ng.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const f = 0.85 + 0.25 * r();
    c[i * 3] = cor.r * f;
    c[i * 3 + 1] = cor.g * f;
    c[i * 3 + 2] = cor.b * f;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return ng;
}

const CORES_FOLHA = [0x4f7a2c, 0x3d6b2a, 0x5b8a34, 0x46713a, 0x6a8f3a, 0x3f5f2e];
const CORES_CASCA = [0x5b4b3d, 0x6a5848, 0x4d4239, 0x726555];

/** Gera a geometria de uma árvore (folhosa ou conífera) com altura total `altura`. */
function geometriaArvore(semente: number, altura: number): GeoArvore {
  const r = rng(semente * 7919 + 13);
  const conifera = r() < 0.18;
  const corFolha = new THREE.Color(CORES_FOLHA[Math.floor(r() * CORES_FOLHA.length)]).offsetHSL(entre(r, -0.02, 0.02), 0, entre(r, -0.04, 0.04));
  const corCasca = new THREE.Color(CORES_CASCA[Math.floor(r() * CORES_CASCA.length)]);
  const troncos: THREE.BufferGeometry[] = [];
  const ints: THREE.BufferGeometry[] = [];
  const exts: THREE.BufferGeometry[] = [];

  if (conifera) {
    const rb = altura * 0.022 + 0.06;
    const ht = altura * 0.18;
    troncos.push(troncoGeo(new THREE.Vector3(), new THREE.Vector3(0, altura * 0.92, 0), rb, rb * 0.25, corCasca, r, 6, true));
    const nCamadas = 5;
    const copaC = new THREE.Vector3(0, (ht + altura) / 2, 0);
    const copaR = new THREE.Vector3(altura * 0.22, (altura - ht) / 2, altura * 0.22);
    for (let i = 0; i < nCamadas; i++) {
      const t = i / (nCamadas - 1);
      const y0 = ht + (altura - ht) * t * 0.78;
      const raio = altura * 0.24 * (1 - t * 0.78);
      const h = (altura - ht) * 0.34;
      for (const [k, escuro, alvo, uv] of [
        [0.8, 0.7, ints, false],
        [1.0, 1.0, exts, true],
      ] as const) {
        const cone = new THREE.ConeGeometry(raio * k, h * k, 9, 2, true).toNonIndexed();
        cone.translate(0, y0 + h * 0.5, 0);
        // deformação leve, mantendo forma cônica
        const pos = cone.attributes.position;
        const sd = r() * 10;
        for (let j = 0; j < pos.count; j++) {
          const x = pos.getX(j);
          const z = pos.getZ(j);
          const d = 1 + 0.18 * ruido3(x * 2, pos.getY(j), z * 2, sd);
          pos.setXYZ(j, x * d, pos.getY(j) - (Math.hypot(x, z) / raio) * 0.12 * h, z * d);
        }
        const nn = new Float32Array(pos.count * 3);
        const cc = new Float32Array(pos.count * 3);
        const tmp = new THREE.Vector3();
        for (let j = 0; j < pos.count; j++) {
          tmp.set(pos.getX(j), pos.getY(j) - copaC.y, pos.getZ(j)).divide(copaR);
          tmp.y += 0.6;
          tmp.normalize();
          nn.set([tmp.x, tmp.y, tmp.z], j * 3);
          const alt = THREE.MathUtils.clamp((pos.getY(j) - copaC.y) / copaR.y, -1, 1);
          const f = escuro * (0.55 + 0.3 * (alt * 0.5 + 0.5)) * (0.92 + 0.16 * r());
          cc.set([corFolha.r * f * 0.85, corFolha.g * f * 0.95, corFolha.b * f * 0.85], j * 3);
        }
        cone.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
        cone.setAttribute('color', new THREE.BufferAttribute(cc, 3));
        if (uv) {
          const u = cone.attributes.uv;
          for (let j = 0; j < u.count; j += 3) {
            const ox = entre(r, 0.05, 0.45);
            const oy = entre(r, 0.05, 0.45);
            u.setXY(j, ox, oy);
            u.setXY(j + 1, ox + 0.5, oy);
            u.setXY(j + 2, ox + 0.25, oy + 0.5);
          }
        } else {
          const u = cone.attributes.uv;
          for (let j = 0; j < u.count; j += 3) {
            u.setXY(j, 0.3, 0.3);
            u.setXY(j + 1, 0.6, 0.3);
            u.setXY(j + 2, 0.45, 0.6);
          }
        }
        alvo.push(cone);
      }
    }
    return {
      tronco: mergeGeometries(troncos)!,
      folhasInt: mergeGeometries(ints)!,
      folhasExt: mergeGeometries(exts)!,
      raioTronco: rb,
      alturaTronco: altura * 0.9,
    };
  }

  // --- folhosa (oiti, ipê, sibipiruna...) ---
  const ht = altura * entre(r, 0.34, 0.46); // altura do fuste
  const rb = 0.06 + altura * entre(r, 0.016, 0.024);
  const altCopa = altura - ht;
  const copaC = new THREE.Vector3(entre(r, -0.2, 0.2), ht + altCopa * 0.52, entre(r, -0.2, 0.2));
  const larg = altCopa * entre(r, 0.55, 0.75);
  const copaR = new THREE.Vector3(larg, altCopa * 0.5, larg * entre(r, 0.85, 1.05));

  const topoFuste = new THREE.Vector3(entre(r, -0.15, 0.15), ht, entre(r, -0.15, 0.15));
  troncos.push(troncoGeo(new THREE.Vector3(), topoFuste, rb, rb * 0.72, corCasca, r, 8, true));

  // aglomerados: um central + coroa de 6-9 ao redor
  const centros: { c: THREE.Vector3; rr: THREE.Vector3 }[] = [];
  centros.push({ c: copaC.clone(), rr: copaR.clone().multiplyScalar(0.72) });
  const nAgl = 6 + Math.floor(r() * 4);
  for (let i = 0; i < nAgl; i++) {
    const ang = (i / nAgl) * Math.PI * 2 + entre(r, -0.3, 0.3);
    const elev = entre(r, -0.35, 0.75);
    const dist = entre(r, 0.5, 0.68);
    const c = new THREE.Vector3(
      copaC.x + Math.cos(ang) * Math.cos(elev) * copaR.x * dist,
      copaC.y + Math.sin(elev) * copaR.y * dist,
      copaC.z + Math.sin(ang) * Math.cos(elev) * copaR.z * dist,
    );
    const rr = entre(r, 0.42, 0.58);
    centros.push({ c, rr: new THREE.Vector3(copaR.x * rr, copaR.y * rr * 0.85, copaR.z * rr) });
  }
  // topo
  centros.push({
    c: new THREE.Vector3(copaC.x + entre(r, -0.3, 0.3), copaC.y + copaR.y * 0.55, copaC.z + entre(r, -0.3, 0.3)),
    rr: copaR.clone().multiplyScalar(0.5),
  });

  // galhos principais do topo do fuste até alguns aglomerados
  for (let i = 1; i < centros.length; i += 2) {
    const alvo = centros[i].c.clone().lerp(copaC, 0.35);
    troncos.push(troncoGeo(topoFuste, alvo, rb * 0.55, rb * 0.18, corCasca, r, 5));
  }

  for (const { c, rr } of centros) {
    const sd = r() * 100;
    const gi = new THREE.IcosahedronGeometry(1, 1);
    ints.push(prepararAglomerado(gi, c, rr.clone().multiplyScalar(0.8), copaC, copaR, corFolha, 0.62, sd, r, 'densa'));
    const ge = new THREE.IcosahedronGeometry(1, 1);
    exts.push(prepararAglomerado(ge, c, rr, copaC, copaR, corFolha, 1.0, sd + 3, r, 'rala'));
  }

  return {
    tronco: mergeGeometries(troncos)!,
    folhasInt: mergeGeometries(ints)!,
    folhasExt: mergeGeometries(exts)!,
    raioTronco: rb,
    alturaTronco: ht,
  };
}

function alturaPadrao(semente: number): number {
  return entre(rng(semente * 31 + 5), 5.5, 9.5);
}

/** Árvore individual (geometria única para a semente). */
export function criarArvore(semente: number, altura?: number): THREE.Group {
  const alt = altura ?? alturaPadrao(semente);
  const geo = geometriaArvore(semente, alt);
  const m = materiaisArvore();
  const g = new THREE.Group();
  g.name = 'arvore';
  g.add(sombra(new THREE.Mesh(geo.tronco, m.tronco)));
  g.add(sombra(new THREE.Mesh(geo.folhasInt, m.int)));
  g.add(sombra(new THREE.Mesh(geo.folhasExt, m.ext)));
  g.rotation.y = rng(semente + 99)() * Math.PI * 2;
  g.userData.colisor = { raio: geo.raioTronco, altura: geo.alturaTronco };
  return g;
}

const N_VARIANTES = 8;
const ALT_REF = 7.5;
let _variantes: GeoArvore[] | null = null;

/** Muitas árvores com InstancedMesh (8 variantes compartilhadas). */
export function criarArvores(posicoes: { x: number; z: number; y?: number; semente: number }[]): THREE.Object3D {
  if (!_variantes) _variantes = Array.from({ length: N_VARIANTES }, (_, i) => geometriaArvore(1000 + i * 17, ALT_REF));
  const vars = _variantes;
  const m = materiaisArvore();
  const grupo = new THREE.Group();
  grupo.name = 'arvores';
  const colisores: { x: number; y: number; z: number; raio: number; altura: number }[] = [];

  const porVar: { mat: THREE.Matrix4; cor: THREE.Color }[][] = vars.map(() => []);
  const q = new THREE.Quaternion();
  const eixoY = new THREE.Vector3(0, 1, 0);
  for (const p of posicoes) {
    const r = rng(p.semente * 2654435761);
    const v = Math.floor(r() * N_VARIANTES);
    const alt = alturaPadrao(p.semente);
    const k = alt / ALT_REF;
    const kxz = k * entre(r, 0.88, 1.12);
    q.setFromAxisAngle(eixoY, r() * Math.PI * 2);
    const mat = new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y ?? 0, p.z), q, new THREE.Vector3(kxz, k, kxz));
    const cor = new THREE.Color();
    // variação de tom: alguns mais amarelados, outros mais escuros
    const tom = entre(r, 0.82, 1.12);
    cor.setRGB(tom * entre(r, 0.95, 1.08), tom, tom * entre(r, 0.9, 1.02));
    porVar[v].push({ mat, cor });
    colisores.push({ x: p.x, y: p.y ?? 0, z: p.z, raio: vars[v].raioTronco * kxz, altura: vars[v].alturaTronco * k });
  }

  vars.forEach((geo, i) => {
    const lista = porVar[i];
    if (!lista.length) return;
    for (const [g, mat] of [
      [geo.tronco, m.tronco],
      [geo.folhasInt, m.int],
      [geo.folhasExt, m.ext],
    ] as const) {
      const im = new THREE.InstancedMesh(g, mat, lista.length);
      lista.forEach((it, j) => {
        im.setMatrixAt(j, it.mat);
        im.setColorAt(j, g === geo.tronco ? new THREE.Color(1, 1, 1) : it.cor);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      sombra(im);
      grupo.add(im);
    }
  });
  grupo.userData.colisores = colisores;
  return grupo;
}

// ---------------------------------------------------------------------------
// Prédios e casas
// ---------------------------------------------------------------------------

interface Paleta {
  parede: string;
  detalhe: string; // faixas, platibanda, molduras
  caixilho: string; // esquadria
}

const PALETAS: Paleta[] = [
  { parede: '#e8dcc4', detalhe: '#b9a98a', caixilho: '#f2f2ee' },
  { parede: '#d9d4cb', detalhe: '#8f8a80', caixilho: '#3b3f44' },
  { parede: '#c98f6b', detalhe: '#ece4d6', caixilho: '#f4f1ea' },
  { parede: '#b9c7cf', detalhe: '#eef0f0', caixilho: '#e9ecee' },
  { parede: '#efe3a9', detalhe: '#c7b779', caixilho: '#ffffff' },
  { parede: '#a7a39b', detalhe: '#d8d4cb', caixilho: '#2f3236' },
  { parede: '#f1efe9', detalhe: '#9da7ad', caixilho: '#6c757b' },
  { parede: '#c7b59a', detalhe: '#7d6a55', caixilho: '#e6e1d7' },
  { parede: '#d7a9a0', detalhe: '#f3ece6', caixilho: '#ffffff' },
];

/** Pintor que desenha ao mesmo tempo o mapa de cor e o de rugosidade. */
class Pintor {
  readonly cor: CanvasRenderingContext2D;
  readonly rug: CanvasRenderingContext2D;
  readonly telaCor: HTMLCanvasElement;
  readonly telaRug: HTMLCanvasElement;
  /** Retângulos de vidro pintados (x, y, w, h em px) — viram janelas acesas à noite. */
  readonly vidros: [number, number, number, number][] = [];
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    const a = novaTela(w, h);
    const b = novaTela(w, h);
    this.cor = a.ctx;
    this.rug = b.ctx;
    this.telaCor = a.canvas;
    this.telaRug = b.canvas;
  }
  ret(x: number, y: number, w: number, h: number, cor: string | CanvasGradient, rug: number): void {
    this.cor.fillStyle = cor;
    this.cor.fillRect(x, y, w, h);
    const v = Math.round(THREE.MathUtils.clamp(rug, 0, 1) * 255);
    this.rug.fillStyle = `rgb(${v},${v},${v})`;
    this.rug.fillRect(x, y, w, h);
  }
  texturas(): { map: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture } {
    return { map: texturaDe(this.telaCor), roughnessMap: texturaDe(this.telaRug, false) };
  }
}

function sujeira(ctx: CanvasRenderingContext2D, w: number, h: number, r: () => number, intens = 1): void {
  // pontilhado de reboco
  for (let i = 0; i < (w * h) / 60; i++) {
    const l = r() < 0.5 ? 0 : 255;
    ctx.fillStyle = `rgba(${l},${l},${l},${0.035 * intens})`;
    ctx.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2);
  }
  // escorrido vertical (marcas de chuva)
  for (let i = 0; i < 14 * intens; i++) {
    const x = r() * w;
    const y = r() * h;
    const gw = 4 + r() * 18;
    const gh = 30 + r() * 120;
    const g = ctx.createLinearGradient(0, y, 0, y + gh);
    g.addColorStop(0, `rgba(40,35,30,${0.1 * intens})`);
    g.addColorStop(1, 'rgba(40,35,30,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, gw, gh);
  }
}

function vidro(p: Pintor, x: number, y: number, w: number, h: number, r: () => number): void {
  p.vidros.push([x, y, w, h]);
  const g = p.cor.createLinearGradient(x, y, x + w * 0.3, y + h);
  const claro = r() < 0.5;
  g.addColorStop(0, claro ? '#a9bfcf' : '#7f97a8');
  g.addColorStop(0.55, '#4a5d6b');
  g.addColorStop(1, '#27323b');
  p.ret(x, y, w, h, g, 0.08);
  // cortina/persiana em parte das janelas
  const t = r();
  if (t < 0.35) {
    const cores = ['#d9ccb0', '#c9b9a0', '#efe9dc', '#b8a891', '#9db0b8'];
    p.cor.fillStyle = cores[Math.floor(r() * cores.length)];
    p.cor.globalAlpha = 0.85;
    const lado = r() < 0.5;
    const cw = w * entre(r, 0.3, 0.55);
    p.cor.fillRect(lado ? x : x + w - cw, y, cw, h);
    p.cor.globalAlpha = 1;
  } else if (t < 0.5) {
    p.cor.fillStyle = 'rgba(230,225,215,0.75)';
    const ph = h * entre(r, 0.3, 0.8);
    for (let yy = y; yy < y + ph; yy += 3) p.cor.fillRect(x, yy, w, 2);
  }
  // reflexo diagonal
  p.cor.fillStyle = 'rgba(255,255,255,0.08)';
  p.cor.beginPath();
  p.cor.moveTo(x + w * 0.15, y);
  p.cor.lineTo(x + w * 0.45, y);
  p.cor.lineTo(x + w * 0.1, y + h);
  p.cor.lineTo(x, y + h);
  p.cor.lineTo(x, y + h * 0.6);
  p.cor.closePath();
  p.cor.fill();
}

// ---------------------------------------------------------------------------
// Luzes noturnas (janelas acesas, luminárias): registro global de materiais
// ---------------------------------------------------------------------------

/** Materiais cuja `emissiveIntensity` acompanha o horário: base × fator do grupo. */
const noturnos: { mat: THREE.MeshStandardMaterial; base: number; grupo: 'janelas' | 'lampadas' }[] = [];
const fatorNoturno = { janelas: 0, lampadas: 0 };
const ouvintesNoturnos = new Set<(fatorLampadas: number) => void>();

function registrarNoturno(mat: THREE.MeshStandardMaterial, base: number, grupo: 'janelas' | 'lampadas'): void {
  noturnos.push({ mat, base, grupo });
  mat.emissiveIntensity = base * fatorNoturno[grupo];
}

/**
 * Liga/desliga (0..1) as janelas acesas dos prédios e as lâmpadas dos postes.
 * `definirHorario` chama isto; só é preciso chamar à mão para efeitos especiais.
 */
export function definirLuzesNoturnas(janelas: number, lampadas: number): void {
  fatorNoturno.janelas = janelas;
  const mudouLamp = fatorNoturno.lampadas !== lampadas;
  fatorNoturno.lampadas = lampadas;
  for (const n of noturnos) n.mat.emissiveIntensity = n.base * fatorNoturno[n.grupo];
  if (mudouLamp) for (const f of ouvintesNoturnos) f(lampadas);
}

/** Fator atual (0..1) das lâmpadas de rua. */
export function fatorLampadas(): number {
  return fatorNoturno.lampadas;
}

/** Recebe o fator das lâmpadas sempre que ele muda (ex.: iluminação pública). Devolve o cancelamento. */
export function aoMudarLampadas(f: (fator: number) => void): () => void {
  ouvintesNoturnos.add(f);
  return () => ouvintesNoturnos.delete(f);
}

const CORES_LUZ_JANELA = ['#ffd49a', '#ffcc88', '#ffe2b8', '#fff1d6', '#d8e6ff', '#c4d8ff', '#ffbf7a'];

/**
 * Mapa emissivo das janelas: cada janela (agrupada por `celula`) acende com
 * probabilidade `prob`, numa cor quente ou fria, mais clara no alto (luz do teto)
 * e às vezes com cortina na frente. Preto = apagado.
 */
function mapaEmissao(
  p: Pintor,
  r: () => number,
  prob: number,
  celula: (x: number, y: number) => string,
  cores: string[] = CORES_LUZ_JANELA,
): THREE.CanvasTexture {
  const { canvas, ctx } = novaTela(p.w, p.h);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, p.w, p.h);
  const estado = new Map<string, { cor: string; nivel: number; cortina: number } | null>();
  for (const [x, y, w, h] of p.vidros) {
    const k = celula(x + w / 2, y + h / 2);
    let e = estado.get(k);
    if (e === undefined) {
      e = r() < prob ? { cor: cores[Math.floor(r() * cores.length)], nivel: entre(r, 0.55, 1), cortina: r() } : null;
      estado.set(k, e);
    }
    if (!e) continue;
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, e.cor);
    g.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalAlpha = e.nivel;
    ctx.fillStyle = e.cor;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 0.45 * e.nivel;
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    if (e.cortina < 0.35) {
      // cortina meio fechada: luz filtrada, mais fraca
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#000';
      ctx.fillRect(x + w * (e.cortina < 0.17 ? 0 : 0.5), y, w * 0.5, h);
    }
    ctx.globalAlpha = 1;
  }
  return texturaDe(canvas);
}

/** Material de parede com janelas que acendem à noite. */
function materialComJanelas(p: Pintor, emissao: THREE.CanvasTexture, base: number): THREE.MeshStandardMaterial {
  const { map, roughnessMap } = p.texturas();
  const m = new THREE.MeshStandardMaterial({
    map,
    roughnessMap,
    roughness: 1,
    metalness: 0,
    emissive: 0xffffff,
    emissiveMap: emissao,
    emissiveIntensity: 0,
  });
  registrarNoturno(m, base, 'janelas');
  return m;
}

type EstiloFachada = 'janelas' | 'varandas' | 'faixas';
const ESTILOS: EstiloFachada[] = ['janelas', 'varandas', 'faixas'];

const PX_FACHADA = 512; // ladrilho: 4 vãos × 4 andares
const VAO = 3; // m
const ANDAR = 3; // m

const cacheFachada = new Map<string, THREE.MeshStandardMaterial>();

/** Material da fachada dos andares-tipo (ladrilho de 4×4 vãos). */
function materialFachada(pi: number, estilo: EstiloFachada, var_: number): THREE.MeshStandardMaterial {
  const chave = `${pi}|${estilo}|${var_}`;
  let m = cacheFachada.get(chave);
  if (m) return m;
  const pal = PALETAS[pi];
  const N = PX_FACHADA;
  const p = new Pintor(N, N);
  const r = rng(pi * 131 + var_ * 17 + estilo.length);
  const pxm = N / (4 * VAO); // pixels por metro
  p.ret(0, 0, N, N, pal.parede, 0.92);
  sujeira(p.cor, N, N, r);
  const temGrade = r() < 0.4;
  const temAr = r() < 0.6;
  for (let a = 0; a < 4; a++) {
    const yTopo = a * ANDAR * pxm; // canvas: y para baixo, andar a do topo
    // faixa da laje
    p.ret(0, yTopo + (ANDAR - 0.28) * pxm, N, 0.28 * pxm, pal.detalhe, 0.85);
    p.cor.fillStyle = 'rgba(0,0,0,0.12)';
    p.cor.fillRect(0, yTopo + ANDAR * pxm - 2, N, 2);
    if (estilo === 'faixas') {
      // janelas em fita contínua (comercial)
      const y0 = yTopo + 0.75 * pxm;
      const hh = 1.75 * pxm;
      p.ret(0, y0 - 3, N, hh + 6, pal.caixilho, 0.4);
      for (let k = 0; k < 8; k++) {
        const x0 = k * 1.5 * pxm + 3;
        vidro(p, x0, y0, 1.5 * pxm - 6, hh, r);
      }
      continue;
    }
    for (let v = 0; v < 4; v++) {
      const xc = (v + 0.5) * VAO * pxm;
      if (estilo === 'varandas') {
        const w = 2.1 * pxm;
        const hh = 2.25 * pxm;
        const x0 = xc - w / 2;
        const y0 = yTopo + (ANDAR - 0.28 - 2.25) * pxm;
        p.ret(x0 - 4, y0 - 4, w + 8, hh + 4, pal.caixilho, 0.4);
        vidro(p, x0, y0, w / 2 - 2, hh, r);
        vidro(p, x0 + w / 2 + 2, y0, w / 2 - 2, hh, r);
        // guarda-corpo (laje da sacada + vidro/grade)
        const yg = y0 + hh - 1.05 * pxm;
        p.ret(x0 - 0.35 * pxm, y0 + hh, w + 0.7 * pxm, 0.16 * pxm, pal.detalhe, 0.8);
        p.cor.fillStyle = 'rgba(190,210,220,0.35)';
        p.cor.fillRect(x0 - 0.35 * pxm, yg, w + 0.7 * pxm, 1.05 * pxm);
        p.ret(x0 - 0.35 * pxm, yg, w + 0.7 * pxm, 3, '#5d6166', 0.3);
        continue;
      }
      // janela de correr com peitoril
      const w = 1.6 * pxm;
      const hh = 1.3 * pxm;
      const x0 = xc - w / 2;
      const y0 = yTopo + (ANDAR - 0.28 - 1.1 - 1.3) * pxm;
      p.ret(x0 - 5, y0 - 5, w + 10, hh + 10, pal.caixilho, 0.4);
      vidro(p, x0, y0, w / 2 - 1.5, hh, r);
      vidro(p, x0 + w / 2 + 1.5, y0, w / 2 - 1.5, hh, r);
      p.ret(x0 - 9, y0 + hh + 5, w + 18, 6, pal.detalhe, 0.7); // peitoril
      p.cor.fillStyle = 'rgba(0,0,0,0.18)';
      p.cor.fillRect(x0 - 9, y0 + hh + 11, w + 18, 3);
      if (temGrade) {
        p.cor.fillStyle = '#2b2d30';
        for (let gx = x0 + 6; gx < x0 + w; gx += 9) p.cor.fillRect(gx, y0, 2, hh);
        p.cor.fillRect(x0, y0 + hh * 0.5, w, 2);
      }
      if (temAr && r() < 0.3) {
        // aparelho de ar-condicionado de janela/split
        const aw = 0.8 * pxm;
        const ah = 0.5 * pxm;
        const ax = x0 + w + 0.25 * pxm;
        const ay = y0 + hh - ah;
        if (ax + aw < (v + 1) * VAO * pxm) {
          p.ret(ax, ay, aw, ah, '#e4e4e0', 0.5);
          p.cor.fillStyle = 'rgba(0,0,0,0.25)';
          for (let gy = ay + 4; gy < ay + ah - 3; gy += 4) p.cor.fillRect(ax + 4, gy, aw - 8, 1);
          p.cor.fillStyle = 'rgba(0,0,0,0.2)';
          p.cor.fillRect(ax, ay + ah, aw, 3);
        }
      }
    }
  }
  // à noite: ~40% dos apartamentos/salas acesos (um vão por andar = uma unidade)
  const bay = (estilo === 'faixas' ? 1.5 * 2 : VAO) * pxm;
  const emissao = mapaEmissao(p, r, 0.4, (x, y) => `${Math.floor(x / bay)},${Math.floor(y / (ANDAR * pxm))}`);
  m = materialComJanelas(p, emissao, 1.1);
  cacheFachada.set(chave, m);
  return m;
}

const cacheTerreo = new Map<number, THREE.MeshStandardMaterial>();
const LOJA = 4; // m, largura de uma loja no ladrilho
const ALT_TERREO = 4; // m

function letreiroFalso(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: () => number): void {
  const fundos = ['#b3261e', '#1f4e8c', '#f2c230', '#2e7d32', '#ffffff', '#222222', '#e86a1a'];
  const f = fundos[Math.floor(r() * fundos.length)];
  ctx.fillStyle = f;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = f === '#ffffff' || f === '#f2c230' ? '#222' : '#fff';
  ctx.font = `bold ${Math.round(h * 0.62)}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const nomes = ['PADARIA', 'FARMÁCIA', 'MERCADO', 'ÓTICA', 'LANCHES', 'PAPELARIA', 'BAZAR', 'ACADEMIA', 'SALÃO', 'AÇOUGUE', 'CALÇADOS', 'PET SHOP'];
  ctx.fillText(nomes[Math.floor(r() * nomes.length)], x + w / 2, y + h / 2 + 1, w * 0.86);
}

/** Térreo comercial: 2 lojas (4 m cada) × 4 m de altura. */
function materialTerreo(v: number): THREE.MeshStandardMaterial {
  let m = cacheTerreo.get(v);
  if (m) return m;
  const W = 512;
  const H = 256;
  const pxm = W / (2 * LOJA);
  const p = new Pintor(W, H);
  const r = rng(v * 977 + 3);
  const pal = PALETAS[v % PALETAS.length];
  p.ret(0, 0, W, H, pal.detalhe, 0.9);
  sujeira(p.cor, W, H, r, 1.4);
  for (let l = 0; l < 2; l++) {
    const x0 = l * LOJA * pxm;
    // pilar
    p.ret(x0, 0, 0.3 * pxm, H, pal.parede, 0.9);
    p.ret(x0 + LOJA * pxm - 0.3 * pxm, 0, 0.3 * pxm, H, pal.parede, 0.9);
    letreiroFalso(p.cor, x0 + 0.45 * pxm, 0.25 * pxm, (LOJA - 0.9) * pxm, 0.6 * pxm, r);
    const ax = x0 + 0.4 * pxm;
    const aw = (LOJA - 0.8) * pxm;
    const ay = 1.05 * pxm;
    const ah = H - ay - 0.15 * pxm;
    if (r() < 0.45) {
      // porta de aço de enrolar (parcialmente aberta)
      const aberta = entre(r, 0.0, 0.7);
      p.ret(ax, ay, aw, ah, '#2a2c2e', 0.3);
      vidro(p, ax + 4, ay + ah * 0.2, aw - 8, ah * 0.8, r);
      const hs = ah * (1 - aberta);
      p.ret(ax, ay, aw, hs, '#9a9d9f', 0.45);
      p.cor.fillStyle = 'rgba(0,0,0,0.22)';
      for (let yy = ay + 3; yy < ay + hs; yy += 4) p.cor.fillRect(ax, yy, aw, 1);
    } else {
      // vitrine com porta de vidro
      p.ret(ax, ay, aw, ah, '#3c4247', 0.3);
      const pw = aw * 0.32;
      vidro(p, ax + 3, ay + 3, aw - pw - 9, ah - 0.5 * pxm, r);
      vidro(p, ax + aw - pw, ay + 3, pw - 3, ah - 3, r);
      p.ret(ax + 3, ay + ah - 0.5 * pxm, aw - pw - 9, 0.5 * pxm - 3, pal.parede, 0.85);
    }
    // soleira / calçada encosta aqui
    p.ret(x0, H - 0.12 * pxm, LOJA * pxm, 0.12 * pxm, '#77736b', 0.9);
  }
  // lojas: vitrine acesa na maioria, luz branca de LED
  const emissao = mapaEmissao(p, r, 0.75, (x) => `${Math.floor(x / (LOJA * pxm))}`, ['#fff6e6', '#f2f6ff', '#ffe9c4']);
  m = materialComJanelas(p, emissao, 0.55);
  cacheTerreo.set(v, m);
  return m;
}

const cacheCasa = new Map<number, THREE.MeshStandardMaterial>();
const LARG_CASA = 8; // m por ladrilho

/** Parede de casa térrea: porta + 2 janelas com grade, rodapé. Ladrilho 8 m × altura. */
function materialCasa(v: number): THREE.MeshStandardMaterial {
  let m = cacheCasa.get(v);
  if (m) return m;
  const W = 512;
  const H = 192; // 8 m × 3 m
  const pxm = W / LARG_CASA;
  const p = new Pintor(W, H);
  const r = rng(v * 557 + 11);
  const pal = PALETAS[v % PALETAS.length];
  p.ret(0, 0, W, H, pal.parede, 0.93);
  sujeira(p.cor, W, H, r, 1.2);
  p.ret(0, H - 0.4 * pxm, W, 0.4 * pxm, pal.detalhe, 0.9); // rodapé
  const janela = (xc: number) => {
    const w = 1.5 * pxm;
    const h = 1.15 * pxm;
    const x0 = xc - w / 2;
    const y0 = 0.55 * pxm;
    p.ret(x0 - 5, y0 - 5, w + 10, h + 10, pal.caixilho, 0.4);
    vidro(p, x0, y0, w, h, r);
    p.cor.fillStyle = '#2b2d30';
    for (let gx = x0 + 5; gx < x0 + w; gx += 8) p.cor.fillRect(gx, y0, 2, h);
    p.cor.fillRect(x0, y0 + h / 3, w, 2);
    p.cor.fillRect(x0, y0 + (2 * h) / 3, w, 2);
    p.ret(x0 - 8, y0 + h + 5, w + 16, 5, pal.detalhe, 0.7);
  };
  janela(1.6 * pxm);
  janela(6.4 * pxm);
  // porta
  const dw = 0.9 * pxm;
  const dh = 2.15 * pxm;
  const dx = 4 * pxm - dw / 2;
  const dy = H - 0.4 * pxm - dh + 0.35 * pxm;
  const madeira = r() < 0.5;
  p.ret(dx - 4, dy - 4, dw + 8, dh + 4, pal.caixilho, 0.4);
  p.ret(dx, dy, dw, dh, madeira ? '#6b4a2f' : '#55606a', madeira ? 0.7 : 0.4);
  p.cor.fillStyle = 'rgba(0,0,0,0.18)';
  for (let k = 0; k < 3; k++) p.cor.fillRect(dx + 6, dy + 8 + k * (dh / 3), dw - 12, dh / 3 - 16);
  p.ret(dx + dw - 12, dy + dh * 0.5, 5, 10, '#c9c4b8', 0.3);
  const emissao = mapaEmissao(p, r, 0.5, (x) => `${Math.floor(x / (4 * pxm))}`, ['#ffcf8f', '#ffc477', '#ffe0b0', '#cfdcff']);
  m = materialComJanelas(p, emissao, 1.0);
  cacheCasa.set(v, m);
  return m;
}

let _matTelhado: THREE.MeshStandardMaterial | null = null;
function materialTelhado(): THREE.MeshStandardMaterial {
  if (_matTelhado) return _matTelhado;
  const W = 128;
  const { canvas, ctx } = novaTela(W, W);
  ctx.fillStyle = '#a4553a';
  ctx.fillRect(0, 0, W, W);
  const r = rng(77);
  // telha cerâmica: canais verticais + fiadas
  for (let x = 0; x < W; x += 8) {
    const g = ctx.createLinearGradient(x, 0, x + 8, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.28)');
    g.addColorStop(0.5, 'rgba(255,220,190,0.12)');
    g.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 8, W);
  }
  for (let y = 0; y < W; y += 16) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, y, W, 2);
  }
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(${r() < 0.5 ? '30,20,10' : '255,230,200'},0.06)`;
    ctx.fillRect(r() * W, r() * W, 4 + r() * 10, 3 + r() * 8);
  }
  const t = texturaDe(canvas);
  t.repeat.set(1 / 1.6, 1 / 1.6); // ladrilho = 1,6 m
  _matTelhado = new THREE.MeshStandardMaterial({ map: t, roughness: 0.8, metalness: 0 });
  return _matTelhado;
}

const matLaje = new THREE.MeshStandardMaterial({ color: 0x6f6d69, roughness: 0.95 });
const cacheDetalhe = new Map<number, THREE.MeshStandardMaterial>();
function materialDetalhe(pi: number): THREE.MeshStandardMaterial {
  let m = cacheDetalhe.get(pi);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: PALETAS[pi].detalhe, roughness: 0.9 });
    cacheDetalhe.set(pi, m);
  }
  return m;
}

/**
 * BoxGeometry com UV em ladrilhos: cada face lateral mostra `nU(w)` × `nV`
 * repetições inteiras (sem janelas cortadas nas quinas).
 */
function caixaLadrilhada(w: number, h: number, d: number, repU: (larg: number) => number, repV: number, deslocU = 0): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // ordem das faces do BoxGeometry: +x, −x, +y, −y, +z, −z (4 vértices cada)
  const largFace = [d, d, w, w, w, d];
  for (let f = 0; f < 6; f++) {
    if (f === 2 || f === 3) continue;
    const ru = repU(largFace[f]);
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * ru + deslocU, uv.getY(i) * repV);
    }
  }
  uv.needsUpdate = true;
  return g;
}

/**
 * Prédio (ou casa térrea, se altura < 6 m). Origem no chão, no centro da
 * planta. Colisor: caixa centrada em (0, altura/2, 0).
 */
export function criarPredio(largura: number, altura: number, profundidade: number, semente: number): THREE.Group {
  const r = rng(semente * 48271 + 7);
  const pi = Math.floor(r() * PALETAS.length);
  const g = new THREE.Group();
  g.name = 'predio';
  const extras: THREE.BufferGeometry[] = [];

  if (altura < 6) {
    // --- casa térrea com telhado cerâmico de duas águas ---
    const mat = materialCasa(Math.floor(r() * PALETAS.length));
    const corpo = caixaLadrilhada(largura, altura, profundidade, (l) => Math.max(1, Math.round(l / LARG_CASA * 2)) / 2, 1);
    corpo.translate(0, altura / 2, 0);
    g.add(sombra(new THREE.Mesh(corpo, [mat, mat, matLaje, matLaje, mat, mat])));
    // telhado: cumeeira ao longo do lado maior
    const aoLongoX = largura >= profundidade;
    const vao = (aoLongoX ? profundidade : largura) + 0.8;
    const comp = (aoLongoX ? largura : profundidade) + 0.8;
    const alturaT = vao * 0.5 * 0.36; // ~20°
    const sh = new THREE.Shape();
    sh.moveTo(-vao / 2, 0);
    sh.lineTo(vao / 2, 0);
    sh.lineTo(0, alturaT);
    sh.closePath();
    const tg = new THREE.ExtrudeGeometry(sh, { depth: comp, bevelEnabled: false });
    tg.translate(0, 0, -comp / 2);
    if (aoLongoX) tg.rotateY(Math.PI / 2);
    tg.translate(0, altura - 0.05, 0);
    g.add(sombra(new THREE.Mesh(tg, materialTelhado())));
    g.userData.colisor = { meiaLargura: largura / 2, meiaAltura: altura / 2, meiaProfundidade: profundidade / 2 };
    return g;
  }

  // --- prédio: térreo comercial + andares-tipo + platibanda ---
  const estilo = ESTILOS[Math.floor(r() * ESTILOS.length)];
  const matF = materialFachada(pi, estilo, Math.floor(r() * 2));
  const matT = materialTerreo(Math.floor(r() * 6));
  const hT = ALT_TERREO;
  const hCorpo = altura - hT;
  const nAndares = Math.max(1, Math.round(hCorpo / ANDAR));
  const repU4 = (l: number) => Math.max(1, Math.round(l / VAO)) / 4;
  const corpo = caixaLadrilhada(largura, hCorpo, profundidade, repU4, nAndares / 4, Math.floor(r() * 4) / 4);
  corpo.translate(0, hT + hCorpo / 2, 0);
  g.add(sombra(new THREE.Mesh(corpo, [matF, matF, matLaje, matLaje, matF, matF])));

  const terreo = caixaLadrilhada(largura, hT, profundidade, (l) => Math.max(1, Math.round(l / LOJA)) / 2, 1, Math.floor(r() * 2) / 2);
  terreo.translate(0, hT / 2, 0);
  g.add(sombra(new THREE.Mesh(terreo, [matT, matT, matLaje, matLaje, matT, matT])));

  // marquise de concreto sobre as lojas (frente +Z e fundos −Z)
  const prof = entre(r, 0.9, 1.4);
  for (const s of [1, -1]) {
    const mq = new THREE.BoxGeometry(largura + 0.3, 0.16, prof);
    mq.translate(0, hT - 0.2, s * (profundidade / 2 + prof / 2));
    extras.push(mq);
  }
  // faixa entre térreo e corpo
  const faixa = new THREE.BoxGeometry(largura + 0.08, 0.3, profundidade + 0.08);
  faixa.translate(0, hT + 0.05, 0);
  extras.push(faixa);
  // platibanda (mureta de cobertura) com pingadeira
  const hp = 0.9;
  const e = 0.2;
  const topo = altura;
  const paredes: [number, number, number, number, number][] = [
    [largura + 0.1, hp, e, 0, profundidade / 2 - e / 2 + 0.05],
    [largura + 0.1, hp, e, 0, -profundidade / 2 + e / 2 - 0.05],
    [e, hp, profundidade + 0.1, largura / 2 - e / 2 + 0.05, 0],
    [e, hp, profundidade + 0.1, -largura / 2 + e / 2 - 0.05, 0],
  ];
  for (const [w, h, d, x, z] of paredes) {
    const b = new THREE.BoxGeometry(w, h, d);
    b.translate(x, topo + h / 2, z);
    extras.push(b);
  }
  // pingadeira: moldura de 0,35 m sobre a platibanda (só a borda; o miolo é a laje)
  const yp = topo + hp + 0.04;
  for (const [w, d, x, z] of [
    [largura + 0.3, 0.35, 0, profundidade / 2 - 0.025],
    [largura + 0.3, 0.35, 0, -profundidade / 2 + 0.025],
    [0.35, profundidade + 0.3, largura / 2 - 0.025, 0],
    [0.35, profundidade + 0.3, -largura / 2 + 0.025, 0],
  ] as const) {
    const b = new THREE.BoxGeometry(w, 0.08, d);
    b.translate(x, yp, z);
    extras.push(b);
  }
  // caixa d'água / casa de máquinas no telhado
  if (altura > 12 && largura > 6 && profundidade > 6) {
    const cw = Math.min(4, largura * 0.35);
    const cd = Math.min(3.5, profundidade * 0.35);
    const ch = entre(r, 2.4, 3.4);
    const cx = entre(r, -largura * 0.15, largura * 0.15);
    const cz = entre(r, -profundidade * 0.15, profundidade * 0.15);
    const c = new THREE.BoxGeometry(cw, ch, cd);
    c.translate(cx, topo + hp + 0.08 + ch / 2, cz);
    extras.push(c);
  }
  const det = mergeGeometries(extras.map((x) => (x.deleteAttribute('uv'), x)))!;
  extras.forEach((x) => x.dispose());
  g.add(sombra(new THREE.Mesh(det, materialDetalhe(pi))));

  g.userData.colisor = { meiaLargura: largura / 2, meiaAltura: altura / 2, meiaProfundidade: profundidade / 2 };
  return g;
}

// ---------------------------------------------------------------------------
// Poste de iluminação pública
// ---------------------------------------------------------------------------

let _poste: { geos: THREE.BufferGeometry[]; mats: THREE.Material[] } | null = null;
const ALT_POSTE = 9;
const R_POSTE_BASE = 0.13;
/** Centro da lente da luminária, em coordenadas do grupo do poste. */
export const CABECA_POSTE = new THREE.Vector3(0, ALT_POSTE + 0.28, 2.38);

/**
 * Poste de concreto cônico com braço metálico e luminária LED. O braço
 * avança para +Z local (gire o grupo para apontar à pista).
 * `userData.lampada` é o material emissivo (compartilhado; acende sozinho com
 * `definirHorario('noite')` / `definirLuzesNoturnas`).
 */
export function criarPosteIluminacao(): THREE.Group {
  if (!_poste) {
    const matConcreto = new THREE.MeshStandardMaterial({ color: 0xa9a7a1, roughness: 0.9 });
    const matMetal = new THREE.MeshStandardMaterial({ color: 0x9fa4a8, metalness: 0.7, roughness: 0.4 });
    const matCorpoLum = new THREE.MeshStandardMaterial({ color: 0x5d6368, metalness: 0.5, roughness: 0.5 });
    const matLente = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, emissive: 0xfff2d8, emissiveIntensity: 0, roughness: 0.2 });
    const fuste = new THREE.CylinderGeometry(0.075, R_POSTE_BASE, ALT_POSTE, 12);
    fuste.translate(0, ALT_POSTE / 2, 0);
    const base = new THREE.CylinderGeometry(0.2, 0.22, 0.12, 12);
    base.translate(0, 0.06, 0);
    const fusteM = mergeGeometries([fuste, base])!;
    const curva = new THREE.CubicBezierCurve3(
      new THREE.Vector3(0, ALT_POSTE - 0.9, 0.04),
      new THREE.Vector3(0, ALT_POSTE + 0.1, 0.2),
      new THREE.Vector3(0, ALT_POSTE + 0.35, 1.0),
      new THREE.Vector3(0, ALT_POSTE + 0.35, 2.1),
    );
    const braco = new THREE.TubeGeometry(curva, 20, 0.032, 8, false);
    const abr = new THREE.CylinderGeometry(0.085, 0.085, 0.25, 10);
    abr.translate(0, ALT_POSTE - 0.85, 0);
    braco.deleteAttribute('uv');
    abr.deleteAttribute('uv');
    const bracoM = mergeGeometries([braco, abr.toNonIndexed()].map((x) => (x.index ? x.toNonIndexed() : x)))!;
    // luminária: corpo achatado levemente inclinado
    const corpo = new THREE.BoxGeometry(0.32, 0.09, 0.7);
    corpo.rotateX(-0.08);
    corpo.translate(0, ALT_POSTE + 0.33, 2.35);
    const lente = new THREE.PlaneGeometry(0.24, 0.5);
    lente.rotateX(Math.PI / 2);
    lente.rotateX(-0.08);
    lente.translate(0, ALT_POSTE + 0.28, 2.38);
    registrarNoturno(matLente, 6, 'lampadas');
    _poste = { geos: [fusteM, bracoM, corpo, lente], mats: [matConcreto, matMetal, matCorpoLum, matLente] };
  }
  const g = new THREE.Group();
  g.name = 'poste';
  _poste.geos.forEach((geo, i) => g.add(sombra(new THREE.Mesh(geo, _poste!.mats[i]), i < 3, true)));
  g.userData.colisor = { raio: R_POSTE_BASE, altura: ALT_POSTE };
  g.userData.lampada = _poste.mats[3];
  return g;
}

// ---------------------------------------------------------------------------
// Muro
// ---------------------------------------------------------------------------

let _matMuro: THREE.MeshStandardMaterial | null = null;
let _matCapa: THREE.MeshStandardMaterial | null = null;
function materiaisMuro() {
  if (!_matMuro) {
    const W = 256;
    const { canvas, ctx } = novaTela(W, W);
    ctx.fillStyle = '#ddd6c8';
    ctx.fillRect(0, 0, W, W);
    sujeira(ctx, W, W, rng(5), 0.7);
    // mancha de umidade no pé
    const g = ctx.createLinearGradient(0, W, 0, W * 0.75);
    g.addColorStop(0, 'rgba(70,60,45,0.35)');
    g.addColorStop(1, 'rgba(70,60,45,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, W * 0.75, W, W * 0.25);
    const t = texturaDe(canvas);
    _matMuro = new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 });
    _matCapa = new THREE.MeshStandardMaterial({ color: 0xb7b0a3, roughness: 0.9 });
  }
  return { muro: _matMuro!, capa: _matCapa! };
}

/** Segmento de muro rebocado (2 m) com pilares, ao longo do eixo X, centrado na origem. */
export function criarCerca(comprimento: number): THREE.Group {
  const m = materiaisMuro();
  const H = 2.0;
  const E = 0.15;
  const g = new THREE.Group();
  g.name = 'muro';
  const parede = new THREE.BoxGeometry(comprimento, H, E);
  // UV em metros (ladrilho de 2 m) para o reboco não esticar
  const uv = parede.attributes.uv;
  const largFace = [E, E, comprimento, comprimento, comprimento, E];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
    const i = f * 4 + k;
    uv.setXY(i, (uv.getX(i) * largFace[f]) / 2, (uv.getY(i) * H) / 2);
  }
  parede.translate(0, H / 2, 0);
  g.add(sombra(new THREE.Mesh(parede, m.muro)));
  const partes: THREE.BufferGeometry[] = [];
  const capa = new THREE.BoxGeometry(comprimento + 0.06, 0.06, E + 0.08);
  capa.translate(0, H + 0.03, 0);
  partes.push(capa);
  const nVaos = Math.max(1, Math.round(comprimento / 3));
  for (let i = 0; i <= nVaos; i++) {
    const x = -comprimento / 2 + (i * comprimento) / nVaos;
    const p = new THREE.BoxGeometry(0.28, H + 0.12, 0.28);
    p.translate(THREE.MathUtils.clamp(x, -comprimento / 2 + 0.14, comprimento / 2 - 0.14), (H + 0.12) / 2, 0);
    partes.push(p);
  }
  g.add(sombra(new THREE.Mesh(mergeGeometries(partes)!, m.capa)));
  partes.forEach((p) => p.dispose());
  g.userData.colisor = { meiaLargura: comprimento / 2, meiaAltura: H / 2, meiaProfundidade: 0.14 };
  return g;
}

// ---------------------------------------------------------------------------
// Céu, sol e névoa
// ---------------------------------------------------------------------------

export type Horario = 'dia' | 'entardecer' | 'noite';

/**
 * O Sky (Preetham) foi calibrado para exposição ~0,5. Em vez de baixar a
 * exposição global (o que escureceria tudo o resto), escalamos a radiância do
 * próprio céu e usamos exposição 1 com intensidades de luz "normais".
 *
 * O shader também ganha um céu noturno (gradiente azul-marinho + halo da lua)
 * misturado por `noite` (0..1), para a transição dia → noite ser contínua.
 */
const ESCALA_CEU = 0.55;
function escalarCeu(ceu: Sky): void {
  const m = ceu.material;
  m.uniforms.escalaCeu = { value: ESCALA_CEU };
  m.uniforms.noite = { value: 0 };
  m.uniforms.corZeniteNoite = { value: new THREE.Color(0x01030a) };
  m.uniforms.corHorizonteNoite = { value: new THREE.Color(0x111a30) };
  m.uniforms.direcaoLua = { value: new THREE.Vector3(0, 1, 0) };
  m.fragmentShader =
    'uniform float escalaCeu;\nuniform float noite;\nuniform vec3 corZeniteNoite;\nuniform vec3 corHorizonteNoite;\nuniform vec3 direcaoLua;\n' +
    m.fragmentShader.replace(
      'gl_FragColor = vec4( texColor, 1.0 );',
      `vec3 corNoite = mix( corHorizonteNoite, corZeniteNoite, pow( clamp( direction.y, 0.0, 1.0 ), 0.5 ) );
      float dl = max( dot( direction, direcaoLua ), 0.0 );
      corNoite += vec3( 0.55, 0.62, 0.8 ) * ( pow( dl, 600.0 ) * 0.06 + pow( dl, 40.0 ) * 0.012 );
      gl_FragColor = vec4( mix( texColor * escalaCeu, corNoite, noite ), 1.0 );`,
    );
}

/** Direção (unitária, apontando PARA a fonte) a partir de elevação e azimute em graus. */
function direcaoDe(elevacao: number, azimute: number): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(elevacao);
  const az = THREE.MathUtils.degToRad(azimute);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
}

const LADO_SOMBRA = 40; // meia largura da caixa de sombra (80 m)
const DURACAO_TRANSICAO = 1.2; // s

/** Tudo o que muda com o horário (interpolável). */
interface EstadoCeu {
  /** Direção da luz direcional (sol ou lua). */
  luz: THREE.Vector3;
  /** Posição do sol no shader do céu (à noite, abaixo do horizonte). */
  solCeu: THREE.Vector3;
  corLuz: THREE.Color;
  intLuz: number;
  hemiCeu: THREE.Color;
  hemiChao: THREE.Color;
  intHemi: number;
  nevoa: THREE.Color;
  nevoaPerto: number;
  nevoaLonge: number;
  exposicao: number;
  escalaCeu: number;
  turbidez: number;
  rayleigh: number;
  mie: number;
  mieG: number;
  nuvens: number;
  ambiente: number; // multiplica environmentIntensity
  noite: number; // céu noturno, estrelas e lua
  janelas: number;
  lampadas: number;
  raioSombra: number;
}

function clonarEstado(e: EstadoCeu): EstadoCeu {
  return {
    ...e,
    luz: e.luz.clone(),
    solCeu: e.solCeu.clone(),
    corLuz: e.corLuz.clone(),
    hemiCeu: e.hemiCeu.clone(),
    hemiChao: e.hemiChao.clone(),
    nevoa: e.nevoa.clone(),
  };
}

function misturarEstado(a: EstadoCeu, b: EstadoCeu, t: number, out: EstadoCeu): void {
  const l = (x: number, y: number) => x + (y - x) * t;
  out.luz.lerpVectors(a.luz, b.luz, t).normalize();
  out.solCeu.lerpVectors(a.solCeu, b.solCeu, t).normalize();
  out.corLuz.lerpColors(a.corLuz, b.corLuz, t);
  out.hemiCeu.lerpColors(a.hemiCeu, b.hemiCeu, t);
  out.hemiChao.lerpColors(a.hemiChao, b.hemiChao, t);
  out.nevoa.lerpColors(a.nevoa, b.nevoa, t);
  for (const k of [
    'intLuz', 'intHemi', 'nevoaPerto', 'nevoaLonge', 'exposicao', 'escalaCeu', 'turbidez', 'rayleigh',
    'mie', 'mieG', 'nuvens', 'ambiente', 'noite', 'janelas', 'lampadas', 'raioSombra',
  ] as const) out[k] = l(a[k], b[k]);
}

function aplicarUniformesCeu(u: Record<string, THREE.IUniform>, e: EstadoCeu): void {
  u.sunPosition.value.copy(e.solCeu);
  u.turbidity.value = e.turbidez;
  u.rayleigh.value = e.rayleigh;
  u.mieCoefficient.value = e.mie;
  u.mieDirectionalG.value = e.mieG;
  u.cloudCoverage.value = e.nuvens;
  u.escalaCeu.value = e.escalaCeu;
  u.noite.value = e.noite;
  u.direcaoLua.value.copy(e.luz);
}

/** Lua: disco com mares escuros e um halo suave (textura de canvas). */
function texturaLua(): THREE.CanvasTexture {
  const N = 256;
  const { canvas, ctx } = novaTela(N, N);
  const c = N / 2;
  const halo = ctx.createRadialGradient(c, c, N * 0.1, c, c, N * 0.5);
  halo.addColorStop(0, 'rgba(200,215,255,0.35)');
  halo.addColorStop(0.4, 'rgba(160,180,230,0.08)');
  halo.addColorStop(1, 'rgba(140,160,220,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, N, N);
  const R = N * 0.13;
  const disco = ctx.createRadialGradient(c - R * 0.3, c - R * 0.3, R * 0.1, c, c, R);
  disco.addColorStop(0, '#fbfbf4');
  disco.addColorStop(1, '#d9dccf');
  ctx.fillStyle = disco;
  ctx.beginPath();
  ctx.arc(c, c, R, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.clip();
  const r = rng(91);
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = `rgba(120,125,130,${entre(r, 0.12, 0.3)})`;
    ctx.beginPath();
    ctx.arc(c + entre(r, -R, R) * 0.8, c + entre(r, -R, R) * 0.8, entre(r, R * 0.08, R * 0.32), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  return texturaDe(canvas);
}

/** Campo de estrelas (um único draw call) numa esfera de raio `raio`, só acima do horizonte. */
function criarEstrelas(raio: number): THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> {
  const r = rng(4242);
  const N = 1400;
  const pos: number[] = [];
  const cor: number[] = [];
  const v = new THREE.Vector3();
  while (pos.length < N * 3) {
    v.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    const l = v.length();
    if (l > 1 || l < 0.1) continue;
    v.divideScalar(l);
    if (v.y < 0.06) continue;
    pos.push(v.x * raio, v.y * raio, v.z * raio);
    // magnitude: poucas brilhantes, muitas fracas; leve tom azul/amarelo; somem perto do horizonte (bruma da cidade)
    const b = Math.pow(r(), 3.2) * 0.9 + 0.12;
    const h = THREE.MathUtils.smoothstep(v.y, 0.06, 0.35);
    const t = r();
    const k = b * h;
    cor.push(k * (t < 0.2 ? 1 : 0.85), k * 0.9, k * (t > 0.8 ? 0.7 : 1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cor, 3));
  const m = new THREE.PointsMaterial({
    size: 1.8,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  p.name = 'estrelas';
  return p;
}

/** Média da cor do horizonte de um céu (para a névoa casar com o fundo). */
function corDoHorizonte(renderer: THREE.WebGLRenderer, cenaCeu: THREE.Scene, padrao: THREE.Color): THREE.Color {
  try {
    const rt = new THREE.WebGLCubeRenderTarget(16, { type: THREE.FloatType });
    const cubo = new THREE.CubeCamera(0.1, 10000, rt);
    cubo.update(renderer, cenaCeu);
    const buf = new Float32Array(16 * 4 * 4);
    const soma = new THREE.Vector3();
    let n = 0;
    for (const face of [0, 1, 4, 5]) {
      renderer.readRenderTargetPixels(rt, 0, 6, 16, 4, buf, face);
      for (let i = 0; i < buf.length; i += 4) {
        if (Number.isFinite(buf[i]) && buf[i] > 0) {
          soma.x += buf[i];
          soma.y += buf[i + 1];
          soma.z += buf[i + 2];
          n++;
        }
      }
    }
    rt.dispose();
    if (n > 8) {
      soma.divideScalar(n);
      return new THREE.Color().setRGB(soma.x, soma.y, soma.z, THREE.LinearSRGBColorSpace);
    }
  } catch {
    /* mantém a cor padrão */
  }
  return padrao.clone();
}

export interface Ceu {
  /** Luz direcional principal: o sol de dia, a lua à noite (sempre a mesma luz, com sombra). */
  sol: THREE.DirectionalLight;
  /** Chame a cada quadro: move a caixa de sombra (e o céu noturno) com `alvo` e avança a transição de horário. */
  atualizarSombra(alvo: THREE.Vector3): void;
  /** Troca o horário. Com `suave` (padrão), mistura em ~1 s (avança em `atualizarSombra`). */
  definirHorario(h: Horario, suave?: boolean): void;
  readonly horario: Horario;
}

/**
 * Configura céu físico (Preetham, com nuvens procedurais do próprio shader),
 * sol direcional com sombra que acompanha `alvo`, luz hemisférica de
 * preenchimento, mapa de ambiente (PMREM do céu), névoa com a cor do
 * horizonte e tone mapping ACES + saída sRGB no renderer. Começa de dia.
 */
export function configurarCeu(cena: THREE.Scene, renderer: THREE.WebGLRenderer): Ceu {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // ---- estados de cada horário (a névoa de dia/entardecer vem do próprio céu, abaixo)
  const ESTADOS: Record<Horario, EstadoCeu> = {
    dia: {
      luz: direcaoDe(36, 215), // tarde agradável
      solCeu: direcaoDe(36, 215),
      corLuz: new THREE.Color(0xffeedd),
      intLuz: 3.0,
      hemiCeu: new THREE.Color(0xe6eef7),
      hemiChao: new THREE.Color(0x8c7a5c),
      intHemi: 1.7,
      nevoa: new THREE.Color(0xbcd0e0),
      nevoaPerto: 90,
      nevoaLonge: 480,
      exposicao: 1.0,
      escalaCeu: ESCALA_CEU,
      turbidez: 2.4,
      rayleigh: 1.8,
      mie: 0.004,
      mieG: 0.82,
      nuvens: 0.38,
      ambiente: 1,
      noite: 0,
      janelas: 0,
      lampadas: 0,
      raioSombra: 2.5,
    },
    entardecer: {
      // hora dourada: sol baixo a oeste-sudoeste, sombras compridas
      luz: direcaoDe(12, 250),
      solCeu: direcaoDe(2.5, 250),
      corLuz: new THREE.Color(0xffa260),
      intLuz: 3.0,
      hemiCeu: new THREE.Color(0xb8b4d0),
      hemiChao: new THREE.Color(0x7a5c44),
      intHemi: 1.3,
      nevoa: new THREE.Color(0xd9a07a),
      nevoaPerto: 70,
      nevoaLonge: 420,
      exposicao: 1.08,
      escalaCeu: 0.62,
      turbidez: 9,
      rayleigh: 3.2,
      mie: 0.009,
      mieG: 0.9,
      nuvens: 0.42,
      ambiente: 0.7,
      noite: 0,
      janelas: 0.35,
      lampadas: 0,
      raioSombra: 3,
    },
    noite: {
      // luar: azulado, fraco, ainda com sombra macia
      luz: direcaoDe(42, 135),
      solCeu: direcaoDe(-12, 260),
      corLuz: new THREE.Color(0x9db4ff),
      intLuz: 0.32,
      hemiCeu: new THREE.Color(0x3b4f80),
      hemiChao: new THREE.Color(0x1a1714),
      intHemi: 0.28,
      nevoa: new THREE.Color(0x0e1424),
      nevoaPerto: 40,
      nevoaLonge: 340,
      exposicao: 1.15,
      escalaCeu: ESCALA_CEU,
      turbidez: 2.4,
      rayleigh: 1.8,
      mie: 0.004,
      mieG: 0.82,
      nuvens: 0.25,
      ambiente: 0.12,
      noite: 1,
      janelas: 1,
      lampadas: 1,
      raioSombra: 5,
    },
  };

  const ceu = new Sky();
  ceu.name = 'ceu';
  escalarCeu(ceu);
  ceu.scale.setScalar(4000);
  ceu.frustumCulled = false;
  const u = ceu.material.uniforms;
  u.cloudDensity.value = 0.5;
  u.cloudElevation.value = 0.55;
  u.cloudScale.value = 0.00022;
  u.time.value = 37;
  ceu.renderOrder = -1000;
  aplicarUniformesCeu(u, ESTADOS.dia);

  // --- mapa de ambiente + cor do horizonte, a partir do céu sem disco solar ---
  const cenaCeu = new THREE.Scene();
  const ceuEnv = new Sky();
  ceuEnv.scale.setScalar(4000);
  escalarCeu(ceuEnv);
  ceuEnv.material.uniforms = THREE.UniformsUtils.clone(u);
  ceuEnv.material.uniforms.showSunDisc.value = 0;
  cenaCeu.add(ceuEnv);
  // chão neutro no mapa de ambiente: sem ele o hemisfério de baixo também é
  // "céu azul" e as sombras ficam azul-marinho
  const chaoEnv = new THREE.Mesh(
    new THREE.CircleGeometry(3000, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(0.32, 0.29, 0.25, THREE.LinearSRGBColorSpace), fog: false }),
  );
  chaoEnv.position.y = -2;

  ESTADOS.dia.nevoa = corDoHorizonte(renderer, cenaCeu, ESTADOS.dia.nevoa);
  aplicarUniformesCeu(ceuEnv.material.uniforms, ESTADOS.entardecer);
  // no entardecer a média do horizonte inclui o lado do sol: puxa um pouco para o lilás do lado oposto
  ESTADOS.entardecer.nevoa = corDoHorizonte(renderer, cenaCeu, ESTADOS.entardecer.nevoa).lerp(new THREE.Color(0x8a7f9a), 0.25);
  aplicarUniformesCeu(ceuEnv.material.uniforms, ESTADOS.dia);

  cenaCeu.add(chaoEnv);
  // mapas de ambiente por horário (só se a cena ainda não tiver um próprio); o do entardecer é gerado na 1ª vez
  const envs: Partial<Record<Horario, THREE.Texture>> = {};
  const temEnvProprio = !!cena.environment;
  const gerarEnv = (h: Horario): THREE.Texture => {
    aplicarUniformesCeu(ceuEnv.material.uniforms, ESTADOS[h]);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(cenaCeu, 0, 0.1, 10000);
    pmrem.dispose();
    return env.texture;
  };
  if (!temEnvProprio) {
    envs.dia = gerarEnv('dia');
    envs.noite = envs.dia; // à noite só escurece
    cena.environment = envs.dia;
    cena.environmentIntensity = 0.12;
  }
  const intAmbienteBase = cena.environmentIntensity;

  cena.background = null;
  cena.add(ceu);
  cena.fog = new THREE.Fog(ESTADOS.dia.nevoa.clone(), 90, 480);
  const nevoa = cena.fog as THREE.Fog;

  const hemi = new THREE.HemisphereLight(0xe6eef7, 0x8c7a5c, 1.7);
  hemi.name = 'luzHemisferica';
  cena.add(hemi);

  const sol = new THREE.DirectionalLight(0xffeedd, 3.0);
  sol.name = 'sol';
  sol.castShadow = true;
  sol.shadow.mapSize.set(2048, 2048);
  const sc = sol.shadow.camera;
  sc.left = -LADO_SOMBRA;
  sc.right = LADO_SOMBRA;
  sc.top = LADO_SOMBRA;
  sc.bottom = -LADO_SOMBRA;
  sc.near = 1;
  sc.far = 300;
  sc.updateProjectionMatrix();
  sol.shadow.bias = -0.0004;
  sol.shadow.normalBias = 0.03;
  sol.shadow.radius = 2.5;
  cena.add(sol);
  cena.add(sol.target);

  // ---- céu noturno: estrelas + lua (acompanham o alvo, ficam "no infinito")
  const RAIO_NOITE = 600; // < camera.far
  const noturno = new THREE.Group();
  noturno.name = 'ceuNoturno';
  const estrelas = criarEstrelas(RAIO_NOITE);
  const matLua = new THREE.SpriteMaterial({
    map: texturaLua(),
    color: new THREE.Color(1.5, 1.5, 1.6),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const lua = new THREE.Sprite(matLua);
  lua.name = 'lua';
  lua.scale.setScalar(RAIO_NOITE * 0.14);
  lua.renderOrder = -998;
  estrelas.renderOrder = -999;
  noturno.add(estrelas, lua);
  noturno.visible = false;
  cena.add(noturno);

  // ---- estado atual + transição
  let horario: Horario = 'dia';
  const atual = clonarEstado(ESTADOS.dia);
  let origem = clonarEstado(ESTADOS.dia);
  let destino = ESTADOS.dia;
  let progresso = 1;
  let ultimo = -1;
  let horarioOrigem: Horario = 'dia';

  function aplicar(e: EstadoCeu): void {
    aplicarUniformesCeu(u, e);
    sol.color.copy(e.corLuz);
    sol.intensity = e.intLuz;
    sol.shadow.radius = e.raioSombra;
    hemi.color.copy(e.hemiCeu);
    hemi.groundColor.copy(e.hemiChao);
    hemi.intensity = e.intHemi;
    nevoa.color.copy(e.nevoa);
    nevoa.near = e.nevoaPerto;
    nevoa.far = e.nevoaLonge;
    renderer.toneMappingExposure = e.exposicao;
    cena.environmentIntensity = intAmbienteBase * e.ambiente;
    if (!temEnvProprio) {
      // troca o mapa de ambiente na metade da transição
      const h = progresso >= 0.5 ? horario : horarioOrigem;
      const env = envs[h] ?? (envs[h] = gerarEnv(h));
      if (cena.environment !== env) cena.environment = env;
    }
    noturno.visible = e.noite > 0.01;
    estrelas.material.opacity = e.noite;
    matLua.opacity = e.noite;
    lua.position.copy(e.luz).multiplyScalar(RAIO_NOITE * 0.92);
    definirLuzesNoturnas(e.janelas, e.lampadas);
  }

  // base do espaço da luz, para "grudar" a caixa de sombra na grade de texels (sem tremulação)
  const frente = new THREE.Vector3();
  const direita = new THREE.Vector3();
  const cima = new THREE.Vector3();
  const p = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);

  function atualizarSombra(alvo: THREE.Vector3): void {
    if (progresso < 1) {
      const agora = performance.now() / 1000;
      const dt = ultimo < 0 ? 1 / 60 : Math.min(0.1, agora - ultimo);
      ultimo = agora;
      progresso = Math.min(1, progresso + dt / DURACAO_TRANSICAO);
      const t = progresso * progresso * (3 - 2 * progresso);
      misturarEstado(origem, destino, t, atual);
      aplicar(atual);
    }
    noturno.position.copy(alvo);

    const dir = atual.luz;
    frente.copy(dir).negate();
    direita.crossVectors(frente, Y).normalize();
    cima.crossVectors(direita, frente).normalize();
    const texel = (2 * LADO_SOMBRA) / (sol.shadow.mapSize.x || 2048);
    const a = Math.round(alvo.dot(direita) / texel) * texel;
    const b = Math.round(alvo.dot(cima) / texel) * texel;
    const c = alvo.dot(frente);
    p.copy(direita).multiplyScalar(a).addScaledVector(cima, b).addScaledVector(frente, c);
    sol.target.position.copy(p);
    sol.position.copy(p).addScaledVector(dir, 150);
    sol.target.updateMatrixWorld();
  }

  function definirHorario(h: Horario, suave = true): void {
    if (h === horario && progresso >= 1) return;
    origem = clonarEstado(atual);
    horarioOrigem = horario;
    horario = h;
    destino = ESTADOS[h];
    if (suave) {
      progresso = 0;
      ultimo = -1;
    } else {
      progresso = 1;
      misturarEstado(origem, destino, 1, atual);
      aplicar(atual);
    }
  }

  aplicar(atual);
  atualizarSombra(new THREE.Vector3());

  return {
    sol,
    atualizarSombra,
    definirHorario,
    get horario() {
      return horario;
    },
  };
}
