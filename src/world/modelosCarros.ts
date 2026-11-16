/**
 * Carros do trânsito a partir do "Car Kit" da Kenney (CC0, public/carros).
 *
 * Os modelos usam um atlas de cores (colormap.png, 16×4 células). Cada carro do
 * trânsito ganha uma cor de pintura trocando, no shader, a célula da pintura do
 * modelo por outra célula do atlas. Lanternas (célula 5,3) e faróis (célula 3,3)
 * viram emissivos no shader, com a intensidade da lanterna ligada ao freio.
 *
 * Os modelos são curtos (≈2,6 m, estilo cartoon): o corpo é esticado no
 * comprimento para bater com a caixa de colisão do trânsito; as rodas ficam fora do
 * grupo esticado para continuarem redondas.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const CELULAS = new THREE.Vector2(16, 4);
const CEL_LANTERNA = new THREE.Vector2(5, 3);
const CEL_FAROL = new THREE.Vector2(3, 3);

interface Modelo {
  nome: string;
  /** Célula do atlas usada pela pintura do modelo. */
  pintura: [number, number];
  /** Pode sair com a cor original? (táxi amarelo, etc. não entram) */
  peso: number;
}

const MODELOS: Modelo[] = [
  { nome: 'sedan', pintura: [13, 1], peso: 3 },
  { nome: 'hatchback-sports', pintura: [7, 1], peso: 3 },
  { nome: 'suv', pintura: [7, 1], peso: 2 },
  { nome: 'suv-luxury', pintura: [9, 1], peso: 2 },
  { nome: 'van', pintura: [15, 1], peso: 1 },
  { nome: 'truck', pintura: [7, 1], peso: 1 },
];

/** Cores de pintura (células do atlas, coluna com degradê). Branco/prata/preto dominam, como na rua. */
const PINTURAS: [number, number][] = [
  [13, 2], [13, 2], [13, 2], // branco
  [11, 2], [11, 2],          // prata
  [3, 2], [3, 2],            // preto
  [9, 2],                    // grafite
  [13, 1],                   // vermelho
  [15, 1],                   // azul
  [5, 1],                    // bege
  [7, 1],                    // verde
];

/** Dimensões alvo (m): batem com a caixa de colisão do trânsito (3,9 × 1,7). */
const COMPRIMENTO_ALVO = 3.8;
const ESCALA_LARG = 1.12;

interface Molde {
  modelo: Modelo;
  corpo: THREE.Object3D;
  rodas: THREE.Object3D[];
  material: THREE.MeshStandardMaterial;
  escalaZ: number;
  /** Cantos das lanternas e dos faróis (no referencial do modelo, antes da escala). */
  lanterna: THREE.Box3 | null;
  farol: THREE.Box3 | null;
}

let moldes: Molde[] | null = null;

/** Caixa dos triângulos do corpo cuja UV cai na célula dada e cuja normal aponta para `nz`. */
function caixaCelula(corpo: THREE.Mesh, cel: THREE.Vector2, nz: number): THREE.Box3 | null {
  const g = corpo.geometry;
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  const idx = g.index;
  if (!pos || !uv) return null;
  const n = idx ? idx.count : pos.count;
  const caixa = new THREE.Box3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3();
  let achou = false;
  for (let k = 0; k < n; k += 3) {
    const i0 = idx ? idx.getX(k) : k, i1 = idx ? idx.getX(k + 1) : k + 1, i2 = idx ? idx.getX(k + 2) : k + 2;
    const u = (uv.getX(i0) + uv.getX(i1) + uv.getX(i2)) / 3;
    const v = (uv.getY(i0) + uv.getY(i1) + uv.getY(i2)) / 3;
    if (Math.floor(u * CELULAS.x) !== cel.x || Math.floor(v * CELULAS.y) !== cel.y) continue;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    nrm.subVectors(b, a).cross(c.clone().sub(a)).normalize();
    if (nrm.z * nz < 0.6) continue;
    caixa.expandByPoint(a).expandByPoint(b).expandByPoint(c);
    achou = true;
  }
  if (!achou) return null;
  caixa.translate(corpo.position);
  return caixa;
}

export async function carregarModelosCarros(base = './carros/'): Promise<void> {
  const loader = new GLTFLoader();
  const lidos = await Promise.all(MODELOS.map((m) => loader.loadAsync(`${base}${m.nome}.glb`).then((g) => ({ m, g }))));
  moldes = lidos.map(({ m, g }) => {
    const cena = g.scene;
    let corpo: THREE.Object3D | null = null;
    const rodas: THREE.Object3D[] = [];
    let material: THREE.MeshStandardMaterial | null = null;
    for (const filho of cena.children) {
      if (filho.name.startsWith('wheel')) rodas.push(filho);
      else if (filho.name === 'body') corpo = filho;
    }
    if (!corpo) throw new Error(`modelo ${m.nome} sem "body"`);
    let malhaCorpo: THREE.Mesh | null = null;
    (corpo as THREE.Object3D).traverse((o) => {
      const mm = o as THREE.Mesh;
      if (mm.isMesh) {
        malhaCorpo ??= mm;
        material ??= mm.material as THREE.MeshStandardMaterial;
      }
    });
    if (!material || !malhaCorpo) throw new Error(`modelo ${m.nome} sem malha`);
    const caixa = new THREE.Box3().setFromObject(cena);
    const comp = caixa.max.z - caixa.min.z;
    // A malha pode estar dentro de um nó filho: a caixa precisa da posição relativa ao corpo
    const mc = malhaCorpo as THREE.Mesh;
    const lanterna = caixaCelula(mc, CEL_LANTERNA, -1);
    const farol = caixaCelula(mc, CEL_FAROL, 1);
    if (mc !== corpo) {
      const off = (corpo as THREE.Object3D).position;
      lanterna?.translate(off);
      farol?.translate(off);
    }
    return {
      modelo: m, corpo, rodas, material,
      escalaZ: COMPRIMENTO_ALVO / comp,
      lanterna, farol,
    };
  });
}

export function modelosCarregados(): boolean {
  return moldes !== null;
}

/** Interface mínima que o trânsito anima. */
export interface LuzAnimada { emissiveIntensity: number }

export interface VisualModelo {
  raiz: THREE.Group;
  rodas: THREE.Object3D[];
  freio: LuzAnimada;
  setaDir: THREE.MeshStandardMaterial;
  setaEsq: THREE.MeshStandardMaterial;
}

function materialPintado(base: THREE.MeshStandardMaterial, de: [number, number], para: [number, number]) {
  const mat = base.clone();
  const uFreio = { value: 0.35 };
  const uDe = { value: new THREE.Vector2(...de) };
  const uPara = { value: new THREE.Vector2(...para) };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uFreio = uFreio;
    sh.uniforms.uDe = uDe;
    sh.uniforms.uPara = uPara;
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uFreio; uniform vec2 uDe; uniform vec2 uPara;
        vec2 celulaUv(vec2 uv) { return floor(uv * vec2(${CELULAS.x}.0, ${CELULAS.y}.0)); }`,
      )
      .replace(
        '#include <map_fragment>',
        `vec2 uvPint = vMapUv;
        vec2 celUv = celulaUv(vMapUv);
        if (all(equal(celUv, uDe))) uvPint += (uPara - uDe) / vec2(${CELULAS.x}.0, ${CELULAS.y}.0);
        vec4 sampledDiffuseColor = texture2D(map, uvPint);
        diffuseColor *= sampledDiffuseColor;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (all(equal(celUv, vec2(${CEL_LANTERNA.x}.0, ${CEL_LANTERNA.y}.0)))) totalEmissiveRadiance += diffuseColor.rgb * uFreio * 0.6;
        if (all(equal(celUv, vec2(${CEL_FAROL.x}.0, ${CEL_FAROL.y}.0)))) totalEmissiveRadiance += diffuseColor.rgb * 0.5;`,
      );
  };
  mat.customProgramCacheKey = () => 'carro-kenney';
  const freio: LuzAnimada = {
    get emissiveIntensity() { return uFreio.value; },
    set emissiveIntensity(v: number) { uFreio.value = v; },
  };
  return { mat, freio };
}

/** Novo carro do trânsito (null se os modelos não foram carregados, ex.: nos testes). */
export function criarVisualModelo(sorteio: () => number): VisualModelo | null {
  if (!moldes) return null;
  const pesoTotal = moldes.reduce((s, m) => s + m.modelo.peso, 0);
  let r = sorteio() * pesoTotal;
  let molde = moldes[0];
  for (const m of moldes) { r -= m.modelo.peso; if (r <= 0) { molde = m; break; } }
  const pintura = PINTURAS[Math.floor(sorteio() * PINTURAS.length)];
  const { mat, freio } = materialPintado(molde.material, molde.modelo.pintura, pintura);

  const raiz = new THREE.Group();
  raiz.name = 'carro_trafego';
  const sx = ESCALA_LARG, sy = ESCALA_LARG, sz = molde.escalaZ;
  const corpo = molde.corpo.clone();
  const esticado = new THREE.Group();
  esticado.scale.set(sx, sy, sz);
  esticado.add(corpo);
  raiz.add(esticado);
  const rodas: THREE.Object3D[] = [];
  for (const rd of molde.rodas) {
    const roda = rd.clone();
    roda.position.set(rd.position.x * sx, rd.position.y * sy, rd.position.z * sz);
    roda.scale.setScalar(sy);
    raiz.add(roda);
    // só as 4 rodas no chão giram (o estepe do SUV fica parado)
    if (rd.position.y < 0.4) rodas.push(roda);
  }
  raiz.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.material = mat;
    m.castShadow = true;
    m.receiveShadow = true;
  });

  // Setas: blocos laranja nos cantos externos das lanternas e dos faróis.
  const setaDir = new THREE.MeshStandardMaterial({ color: 0x8a5a00, emissive: 0xff9a00, emissiveIntensity: 0, roughness: 0.3 });
  const setaEsq = setaDir.clone();
  const geoSeta = new THREE.BoxGeometry(0.1, 0.07, 0.03);
  const pontos: [THREE.Box3 | null, number][] = [[molde.lanterna, -1], [molde.farol, 1]];
  for (const [cx, sentido] of pontos) {
    if (!cx) continue;
    const y = (cx.min.y + cx.max.y) / 2 * sy;
    const z = (sentido > 0 ? cx.max.z : cx.min.z) * sz + sentido * 0.02;
    const x = Math.max(Math.abs(cx.min.x), Math.abs(cx.max.x)) * sx;
    // direita do carro = −X local
    for (const [lado, m] of [[-1, setaDir], [1, setaEsq]] as const) {
      const s = new THREE.Mesh(geoSeta, m);
      s.position.set(lado * (x + 0.02), y, z);
      raiz.add(s);
    }
  }
  return { raiz, rodas, freio, setaDir, setaEsq };
}
