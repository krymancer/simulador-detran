import * as THREE from 'three';
import { ALTURA_CALCADA, lerGrade, METROS_POR_PX } from './autoescola';
import grade from './autoescola/grade.json';
import { aoMudarLampadas, CABECA_POSTE, criarPosteIluminacao, fatorLampadas } from './ambiente';
import { amostrar, type Faixa } from './vias';

/**
 * Iluminação pública da pista: postes na calçada externa do anel e na avenida
 * diagonal. À noite, para ficar barato, NÃO há uma luz real por poste:
 *  - a lente de cada luminária é emissiva (material compartilhado);
 *  - uma "poça de luz" no chão (decalque aditivo, um InstancedMesh só) e um
 *    halo em volta da lâmpada (um Points só) dão a impressão de luz de longe;
 *  - até `N_LUZES` SpotLights reais são remanejadas a cada quadro para os
 *    postes mais perto do carro (`atualizarIluminacaoPublica`), e a poça
 *    falsa daquele poste some enquanto a luz real está nele.
 *
 * Não usa DOM (texturas geradas em DataTexture), então roda nos testes.
 * Cada poste mantém `userData.colisor` (o parser vira cilindro sólido).
 */

/** Luzes reais no máximo (mude só antes de criar: a contagem fixa evita recompilar shaders). */
export const N_LUZES = 6;
const RAIO_POCA = 7; // m
const INT_LUZ = 55; // cd — com decay 1,5 dá ~2 lx-ish no chão a 9 m, parecido com o farol a 10 m
const ALCANCE_LUZ = 24; // m
const COR_LUZ = 0xffe6c2; // LED ~4000 K
const VEL_TROCA = 3; // 1/s — rapidez com que uma luz real entra/sai de um poste

interface Poste {
  grupo: THREE.Group;
  /** Centro da lente (mundo). */
  cabeca: THREE.Vector3;
  /** Peso da luz real neste poste (0..1, suavizado). */
  peso: number;
  /** Índice da luz real alocada, ou −1. */
  slot: number;
}

interface Estado {
  postes: Poste[];
  luzes: THREE.SpotLight[];
  donos: (Poste | null)[];
  pocas: THREE.InstancedMesh;
  halos: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  fator: number;
  ultimo: number;
  cancelar: () => void;
}

// ---------------------------------------------------------------------------
// Texturas (sem canvas)
// ---------------------------------------------------------------------------

let _texPoca: THREE.DataTexture | null = null;
let _texHalo: THREE.DataTexture | null = null;

function texturaRadial(n: number, perfil: (r: number) => number): THREE.DataTexture {
  const d = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const r = Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5) * 2;
      const v = Math.round(255 * THREE.MathUtils.clamp(perfil(r), 0, 1));
      const i = (y * n + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  const t = new THREE.DataTexture(d, n, n, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

function texPoca(): THREE.DataTexture {
  // queda suave, mais forte no centro (cone da luminária)
  return (_texPoca ??= texturaRadial(64, (r) => (r >= 1 ? 0 : Math.pow(1 - r * r, 2.2))));
}

function texHalo(): THREE.DataTexture {
  return (_texHalo ??= texturaRadial(64, (r) => (r >= 1 ? 0 : Math.pow(1 - r, 3) * 0.9 + Math.exp(-r * r * 60) * 0.6)));
}

// ---------------------------------------------------------------------------
// Posicionamento
// ---------------------------------------------------------------------------

function elevadoNaGrade() {
  const g = lerGrade();
  const C = grade.celulaPx;
  const W = grade.larguraPx;
  const H = grade.alturaPx;
  /** Mundo → é calçada/canteiro? `null` = fora da planta (grama). */
  return (x: number, z: number): boolean | null => {
    const xp = x / METROS_POR_PX + W / 2;
    const yp = z / METROS_POR_PX + H / 2;
    if (xp < 0 || yp < 0 || xp >= W || yp >= H) return null;
    const cx = Math.floor(xp / C);
    const cy = Math.floor(yp / C);
    return !!g[cy]?.[cx];
  };
}

function distanciaAFaixa(f: Faixa, x: number, z: number): number {
  let m = Infinity;
  const n = f.pontos.length;
  const segs = f.fechada ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = f.pontos[i];
    const b = f.pontos[(i + 1) % n];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const t = THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / (abx * abx + abz * abz || 1e-9), 0, 1);
    m = Math.min(m, Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t)));
  }
  return m;
}

/**
 * Pontos de poste: ao longo de `faixa`, deslocados `desloc` m para o lado
 * `lado(ponto, normalEsquerda)` (+1 = esquerda do trânsito), ajustados até cair
 * em calçada (com 0,5 m de calçada entre o poste e o asfalto).
 */
function pontosAoLongo(
  faixa: Faixa,
  espacamento: number,
  desloc: number[],
  ladoDe: (p: THREE.Vector3, esq: THREE.Vector3) => number,
  ok: (x: number, z: number, n: THREE.Vector3) => boolean,
  inicio = 0,
): { x: number; z: number; nx: number; nz: number }[] {
  const out: { x: number; z: number; nx: number; nz: number }[] = [];
  const passo = 1;
  let proximo = inicio;
  const fim = faixa.fechada ? faixa.comprimento - espacamento * 0.5 : faixa.comprimento;
  for (let s = inicio; s <= fim; s += passo) {
    if (s < proximo) continue;
    const { ponto, direcao } = amostrar(faixa, s);
    const esq = new THREE.Vector3(direcao.z, 0, -direcao.x);
    const n = esq.multiplyScalar(ladoDe(ponto, esq));
    for (const d of desloc) {
      const x = ponto.x + n.x * d;
      const z = ponto.z + n.z * d;
      if (ok(x, z, n)) {
        out.push({ x, z, nx: n.x, nz: n.z });
        proximo = s + espacamento;
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface OpcoesIluminacao {
  /** Distância entre postes (m). Padrão 22. */
  espacamento?: number;
  /** Pula pontos onde isto é verdade (ex.: entradas, placas, faixas de pedestre). */
  evitar?: (x: number, z: number) => boolean;
}

/**
 * Postes de iluminação na calçada externa do anel (`anel_externo`) e alguns na
 * avenida diagonal. Cada filho `poste_N` é um `criarPosteIluminacao()` com o
 * braço virado para a pista e `userData.colisor`. Acende sozinho quando o
 * horário muda (`definirHorario` em ambiente.ts); `definirIluminacaoPublica`
 * força ligado/desligado.
 */
export function criarIluminacaoPublica(faixas: Faixa[], opcoes: OpcoesIluminacao = {}): THREE.Group {
  const esp = opcoes.espacamento ?? 22;
  const evitar = opcoes.evitar ?? (() => false);
  const elev = elevadoNaGrade();
  const pistas = faixas;
  const colocados: { x: number; z: number }[] = [];

  /** Cabe um poste aqui? calçada sob o poste e entre ele e o asfalto, longe de toda faixa e de outros postes. */
  const ok = (x: number, z: number, n: THREE.Vector3, minDist: number): boolean => {
    const aqui = elev(x, z);
    if (aqui === false) return false;
    for (const k of [0.5, 0.25]) if (elev(x - n.x * k, z - n.z * k) === false) return false;
    for (const f of pistas) if (distanciaAFaixa(f, x, z) < f.meiaLargura + 0.9) return false;
    for (const c of colocados) if (Math.hypot(c.x - x, c.z - z) < minDist) return false;
    return !evitar(x, z);
  };

  const pontos: { x: number; z: number; nx: number; nz: number }[] = [];
  const anel = faixas.find((f) => f.id === 'anel_externo');
  if (anel) {
    const cx = anel.pontos.reduce((a, p) => a + p.x, 0) / anel.pontos.length;
    const cz = anel.pontos.reduce((a, p) => a + p.z, 0) / anel.pontos.length;
    const fora = (p: THREE.Vector3, esq: THREE.Vector3) => (esq.x * (p.x - cx) + esq.z * (p.z - cz) >= 0 ? 1 : -1);
    for (const q of pontosAoLongo(anel, esp, [3, 2.7, 3.3, 2.5, 3.6, 4, 4.5], fora, (x, z, n) => ok(x, z, n, esp * 0.6))) {
      pontos.push(q);
      colocados.push(q);
    }
  }
  // avenida diagonal: nas calçadas laterais (das faixas de fora), alternando os lados
  const d1 = faixas.find((f) => f.id === 'diagonal_1');
  const d3 = faixas.find((f) => f.id === 'diagonal_3');
  const d2 = faixas.find((f) => f.id === 'diagonal_2');
  if (d1 && d3 && d2) {
    const meio = d2.pontos[Math.floor(d2.pontos.length / 2)];
    for (const [f, ini] of [[d1, esp * 0.25], [d3, esp * 0.75]] as const) {
      // lado da faixa de fora que se afasta do centro da avenida
      const mf = f.pontos[Math.floor(f.pontos.length / 2)];
      const ladoFora = (_p: THREE.Vector3, esq: THREE.Vector3) => (esq.x * (mf.x - meio.x) + esq.z * (mf.z - meio.z) >= 0 ? 1 : -1);
      for (const q of pontosAoLongo(f, esp * 1.2, [2.9, 2.6, 3.2, 3.6, 4], ladoFora, (x, z, n) => ok(x, z, n, esp * 0.5), ini)) {
        pontos.push(q);
        colocados.push(q);
      }
    }
  }

  const raiz = new THREE.Group();
  raiz.name = 'iluminacaoPublica';
  const postes: Poste[] = [];
  const matriz = new THREE.Matrix4();
  for (const [i, q] of pontos.entries()) {
    const g = criarPosteIluminacao();
    g.name = `poste_${i}`;
    g.position.set(q.x, ALTURA_CALCADA, q.z);
    g.rotation.y = Math.atan2(-q.nx, -q.nz); // braço (+Z local) para a pista
    g.updateMatrix();
    raiz.add(g);
    postes.push({ grupo: g, cabeca: CABECA_POSTE.clone().applyMatrix4(g.matrix), peso: 0, slot: -1 });
  }

  // poças de luz falsas (um draw call)
  const geoPoca = new THREE.PlaneGeometry(RAIO_POCA * 2, RAIO_POCA * 2).rotateX(-Math.PI / 2);
  const matPoca = new THREE.MeshBasicMaterial({
    map: texPoca(),
    color: new THREE.Color(COR_LUZ).multiplyScalar(0.17),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const pocas = new THREE.InstancedMesh(geoPoca, matPoca, Math.max(1, postes.length));
  pocas.name = 'pocasDeLuz';
  pocas.count = postes.length;
  pocas.renderOrder = 2;
  for (const [i, p] of postes.entries()) {
    // um pouco para fora da cabeça (a luminária inclina para a pista), na altura do asfalto/calçada
    matriz.makeTranslation(p.cabeca.x, 0.03, p.cabeca.z);
    pocas.setMatrixAt(i, matriz);
    pocas.setColorAt(i, new THREE.Color(1, 1, 1));
  }
  pocas.instanceMatrix.needsUpdate = true;
  if (pocas.instanceColor) pocas.instanceColor.needsUpdate = true;
  pocas.computeBoundingSphere();
  raiz.add(pocas);

  // halos nas lâmpadas (um draw call)
  const geoHalo = new THREE.BufferGeometry();
  geoHalo.setAttribute('position', new THREE.Float32BufferAttribute(postes.flatMap((p) => [p.cabeca.x, p.cabeca.y - 0.05, p.cabeca.z]), 3));
  const halos = new THREE.Points(
    geoHalo,
    new THREE.PointsMaterial({
      map: texHalo(),
      color: new THREE.Color(COR_LUZ),
      size: 2.6,
      sizeAttenuation: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    }),
  );
  halos.name = 'halosLampadas';
  halos.renderOrder = 3;
  raiz.add(halos);

  // luzes reais, em número fixo
  const luzes: THREE.SpotLight[] = [];
  for (let i = 0; i < N_LUZES; i++) {
    const s = new THREE.SpotLight(COR_LUZ, 0, ALCANCE_LUZ, 1.05, 0.75, 1.5);
    s.name = `luzPoste_${i}`;
    s.castShadow = false;
    raiz.add(s, s.target);
    luzes.push(s);
  }

  const estado: Estado = {
    postes,
    luzes,
    donos: luzes.map(() => null),
    pocas,
    halos,
    fator: -1,
    ultimo: -1,
    cancelar: () => {},
  };
  raiz.userData.iluminacao = estado;
  aplicarFator(estado, fatorLampadas());
  estado.cancelar = aoMudarLampadas((f) => aplicarFator(estado, f));
  raiz.addEventListener('removed', () => estado.cancelar());
  return raiz;
}

function aplicarFator(e: Estado, f: number): void {
  if (e.fator === f) return;
  const ligou = f > 0.01;
  e.fator = f;
  e.pocas.visible = ligou;
  e.halos.visible = ligou;
  e.halos.material.opacity = f;
  // visibilidade das luzes reais só muda ao ligar/desligar (trocar o nº de luzes recompila os shaders)
  for (const s of e.luzes) s.visible = ligou;
  atualizarPesos(e);
}

function atualizarPesos(e: Estado): void {
  const col = new THREE.Color();
  for (const [i, p] of e.postes.entries()) {
    // a poça falsa some onde a luz real está
    col.setScalar(e.fator * (1 - p.peso));
    e.pocas.setColorAt(i, col);
  }
  if (e.pocas.instanceColor) e.pocas.instanceColor.needsUpdate = true;
  for (const [k, s] of e.luzes.entries()) {
    const p = e.donos[k];
    s.intensity = p ? INT_LUZ * p.peso * e.fator : 0;
  }
}

/** Liga/desliga a iluminação pública deste grupo (a lente emissiva é global: veja `definirLuzesNoturnas`). */
export function definirIluminacaoPublica(grupo: THREE.Group, ligada: boolean): void {
  const e = grupo.userData.iluminacao as Estado | undefined;
  if (e) aplicarFator(e, ligada ? 1 : 0);
}

/**
 * Chame a cada quadro: leva as `N_LUZES` luzes reais para os postes mais perto
 * de `posicaoCarro` (troca suave). Sem custo de dia.
 */
export function atualizarIluminacaoPublica(grupo: THREE.Group, posicaoCarro: THREE.Vector3, dt?: number): void {
  const e = grupo.userData.iluminacao as Estado | undefined;
  if (!e || e.fator <= 0.01 || e.postes.length === 0) {
    if (e) e.ultimo = -1;
    return;
  }
  if (dt === undefined) {
    const agora = performance.now() / 1000;
    dt = e.ultimo < 0 ? 1 / 60 : Math.min(0.1, agora - e.ultimo);
    e.ultimo = agora;
  }
  // os N_LUZES − 1 mais próximos querem luz (sobra uma vaga para o que está saindo)
  const quer = Math.min(e.postes.length, N_LUZES - 1);
  const ordem = e.postes
    .map((p) => ({ p, d: (p.cabeca.x - posicaoCarro.x) ** 2 + (p.cabeca.z - posicaoCarro.z) ** 2 }))
    .sort((a, b) => a.d - b.d);
  const desejados = new Set(ordem.slice(0, quer).map((o) => o.p));
  for (const p of e.postes) {
    const alvo = desejados.has(p) && p.slot >= 0 ? 1 : 0;
    p.peso = alvo > p.peso ? Math.min(1, p.peso + dt * VEL_TROCA) : Math.max(0, p.peso - dt * VEL_TROCA);
    if (p.slot >= 0 && p.peso === 0 && !desejados.has(p)) {
      e.donos[p.slot] = null;
      p.slot = -1;
    }
  }
  // aloca vagas livres para os desejados ainda sem luz (do mais perto ao mais longe)
  for (const { p } of ordem.slice(0, quer)) {
    if (p.slot >= 0) continue;
    let k = e.donos.indexOf(null);
    if (k < 0) {
      // sem vaga: toma a do poste não desejado com menor peso
      let pior = -1;
      for (const [j, d] of e.donos.entries()) if (d && !desejados.has(d) && (pior < 0 || d.peso < e.donos[pior]!.peso)) pior = j;
      if (pior < 0) continue;
      e.donos[pior]!.slot = -1;
      e.donos[pior]!.peso = 0;
      k = pior;
    }
    e.donos[k] = p;
    p.slot = k;
    const s = e.luzes[k];
    s.position.copy(p.cabeca);
    // aponta para baixo, levemente para a pista (frente da luminária)
    const frente = new THREE.Vector3(0, 0, 1).applyQuaternion(p.grupo.quaternion);
    s.target.position.copy(p.cabeca).addScaledVector(frente, 1.2).setY(0);
    s.updateMatrixWorld();
    s.target.updateMatrixWorld();
  }
  atualizarPesos(e);
}

/** Postes criados (para testes/depuração): posição do pé e da cabeça. */
export function postesDe(grupo: THREE.Group): { pe: THREE.Vector3; cabeca: THREE.Vector3; luz: number }[] {
  const e = grupo.userData.iluminacao as Estado | undefined;
  return (e?.postes ?? []).map((p) => ({ pe: p.grupo.position.clone(), cabeca: p.cabeca.clone(), luz: p.slot }));
}
