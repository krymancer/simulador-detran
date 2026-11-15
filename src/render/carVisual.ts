import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Veiculo } from '../sim/vehicle';

/**
 * Visual do carro (Fiat Mobi estilizado), 100% procedural.
 *
 * Referencial local (o mesmo da física): +Z = frente, +Y = cima, +X = ESQUERDA.
 * Origem = centro de massa, que fica `alturaCG` acima do chão. Abaixo, "h" é sempre
 * altura em relação ao chão; `Y(h)` converte para o referencial do carro.
 *
 * A carroceria é UMA superfície "loft" (seções transversais ao longo de Z). Janelas,
 * caixas de roda, frisos de porta, plásticos pretos e o forro interno são resolvidos
 * no fragment shader a partir da posição local — por isso os recortes ficam nítidos
 * e a carroceria inteira custa uma draw call. O vidro usa a mesma superfície com a
 * máscara invertida.
 */

export interface EstadoVisual {
  freando: boolean; re: boolean; farol: boolean; alerta: boolean;
  seta: 'esquerda' | 'direita' | null; piscando: boolean; // piscando = fase acesa do pisca
  cockpit: boolean;            // câmera dentro: esconde o que atrapalha a visão (corpo/cabeça do motorista)
  acelerador: number; freio: number; embreagem: number; // 0..1
  marcha: number;              // -1 R, 0 N, 1..5
  freioDeMao: boolean;
  rpm: number; velocidadeKmh: number; ignicao: boolean; motorLigado: boolean; cinto: boolean;
}

// ---------------------------------------------------------------------------
// Constantes de estilo
// ---------------------------------------------------------------------------

/** Cor da pintura (vermelho tipo "Montecarlo"). */
const COR_PINTURA = 0xa8121a;
const COR_PLASTICO = 0x161718;
const COR_FORRO = 0x7c7973;      // teto/colunas por dentro
const COR_ACABAMENTO = 0x3b3d41; // plástico interno escuro
const COR_PELE = 0xc08a64;
const COR_CAMISA = 0x34507a;

// Perfil da carroceria (z em metros no referencial do carro, h = altura do chão)
const Z_FRENTE = 1.62;
const Z_TRAS = -1.945;
const MEIA_LARG = 0.812;
const Z_COLUNA_B = -0.625;
const Z_DIVISOR_C = -1.33;
const H_CAIXA_RODA = 0.3;
const R_CAIXA_RODA = 0.36;

// Posições internas (motorista à esquerda, +X)
const X_MOT = 0.36;
const H_OLHO = 1.21;
const Z_OLHO = -0.5;
const VOLANTE_H = 0.905;
const VOLANTE_Z = -0.05;
const VOLANTE_R = 0.185;
const VOLANTE_INCL = 0.44; // rad: topo do aro inclinado para a frente

type V3 = THREE.Vector3;
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** Interpolação cúbica monotônica (PCHIP): curva suave sem "ondas" entre os nós. */
function pchip(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = new Array(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) continue;
    const h0 = xs[i] - xs[i - 1], h1 = xs[i + 1] - xs[i];
    const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

const smin = (a: number, b: number, k: number) => {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
};

/** Silhueta lateral: topo (capô → para-brisa → teto → vidro traseiro). */
const topo = pchip(
  [Z_TRAS, -1.915, -1.84, -1.76, -1.6, -1.0, -0.4, -0.12, 0.3, 0.72, 0.95, 1.2, 1.42, 1.55, Z_FRENTE],
  [0.98, 1.06, 1.32, 1.415, 1.45, 1.475, 1.478, 1.45, 1.21, 0.965, 0.93, 0.885, 0.835, 0.79, 0.68],
);
/** Linha de baixo (vão livre, ângulos de entrada/saída). */
const baixo = pchip([Z_TRAS, -1.86, -1.6, 1.3, 1.52, Z_FRENTE], [0.42, 0.32, 0.2, 0.19, 0.25, 0.32]);
/** Linha de cintura (base dos vidros laterais), sobe um pouco para trás. */
const cintura = (z: number) => 0.985 + 0.02 * (0.72 - z);
/** Meia-largura em planta: cantos arredondados na frente, quase retos atrás. */
function largura(z: number): number {
  let k = 1;
  const zf = Z_FRENTE - 0.42;
  if (z > zf) {
    const t = Math.min(1, (z - zf) / 0.42);
    k = Math.pow(1 - Math.pow(t, 2.4), 1 / 2.4);
  }
  const zt = Z_TRAS + 0.11;
  if (z < zt) {
    const t = Math.min(1, (zt - z) / 0.11);
    k = Math.pow(1 - Math.pow(t, 2.6), 1 / 2.6);
  }
  return MEIA_LARG * k;
}

// Número de pontos por trecho da meia-seção (fundo, canto inf., lateral, inclinação do vidro, canto sup., teto)
const TRECHOS = [6, 4, 8, 9, 8, 7];
const V_TRECHOS = [0, 0.15, 0.25, 0.5, 0.75, 0.88, 1];
const N_MEIA = TRECHOS.reduce((a, b) => a + b, 0) + 1;

/** Meia-seção esquerda (x ≥ 0) na estação z: listas [x, h, v] de baixo (v=0) até o meio do teto (v=1). */
function secao(z: number, out: Float64Array): void {
  const B = baixo(z), T = topo(z), W = largura(z);
  const k = Math.min(1, W / 0.5);
  const S = smin(cintura(z), T - 0.15, 0.06);
  const f = clamp((T - S - 0.14) / 0.3, 0, 1);
  const rb = 0.08 * k;
  const ins = (0.045 + 0.105 * f) * k;
  const r = (0.06 + 0.05 * f) * k;
  const crown = 0.025 * f;
  const P0 = [0, B], P1 = [W - rb, B], C1 = [W, B], P2 = [W, B + rb];
  const Cl = [W + 0.012 * k, (B + rb + S) / 2], P3 = [W, S];
  const C = [W - ins, T];
  const dx = P3[0] - C[0], dy = P3[1] - C[1];
  const L = Math.max(1e-6, Math.hypot(dx, dy));
  const rr = Math.min(r, L * 0.6);
  const P4 = [C[0] + (dx * rr) / L, C[1] + (dy * rr) / L];
  const P5 = [Math.max(0, W - ins - rr), T], P6 = [0, T + crown];
  const lin = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const bez = (a: number[], c: number[], b: number[], t: number) => {
    const u = 1 - t;
    return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
  };
  const segs: ((t: number) => number[])[] = [
    (t) => lin(P0, P1, t),
    (t) => bez(P1, C1, P2, t),
    (t) => bez(P2, Cl, P3, t),
    (t) => lin(P3, P4, t),
    (t) => bez(P4, C, P5, t),
    (t) => lin(P5, P6, t),
  ];
  let o = 0;
  for (let s = 0; s < segs.length; s++) {
    const n = TRECHOS[s];
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const p = segs[s](t);
      out[o++] = p[0];
      out[o++] = p[1];
      out[o++] = V_TRECHOS[s] + (V_TRECHOS[s + 1] - V_TRECHOS[s]) * t;
    }
  }
  out[o++] = P6[0];
  out[o++] = P6[1];
  out[o++] = 1;
}

const _sec = new Float64Array(N_MEIA * 3);
/** Ponto (x,h,z) está dentro do volume da carroceria? (usado para "colar" peças na lataria) */
function dentro(x: number, h: number, z: number): boolean {
  if (z > Z_FRENTE || z < Z_TRAS) return false;
  secao(z, _sec);
  if (h < _sec[1] || h > _sec[(N_MEIA - 1) * 3 + 1]) return false;
  for (let i = 0; i < N_MEIA - 1; i++) {
    const h0 = _sec[i * 3 + 1], h1 = _sec[i * 3 + 4];
    if (h >= h0 && h <= h1) {
      const t = h1 > h0 ? (h - h0) / (h1 - h0) : 0;
      const xs = _sec[i * 3] + (_sec[i * 3 + 3] - _sec[i * 3]) * t;
      return Math.abs(x) <= xs;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Texturas procedurais (canvas)
// ---------------------------------------------------------------------------

function tela(w: number, h: number, desenhar: (c: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d')!;
  desenhar(c, w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Polígono com cantos arredondados, coordenadas (s,t) em 0..1 (t para cima). */
function poligonoSuave(c: CanvasRenderingContext2D, w: number, h: number, pts: number[][]): void {
  const P = pts.map(([s, t]) => [s * w, (1 - t) * h]);
  const n = P.length;
  const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  c.beginPath();
  const m0 = mid(P[n - 1], P[0]);
  c.moveTo(m0[0], m0[1]);
  for (let i = 0; i < n; i++) {
    const m = mid(P[i], P[(i + 1) % n]);
    c.quadraticCurveTo(P[i][0], P[i][1], m[0], m[1]);
  }
  c.closePath();
}

function retArred(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

/** Céu + chão + silhuetas no horizonte: dá reflexo à pintura e aos vidros sem HDRI. */
function texturaAmbiente(): THREE.CanvasTexture {
  const t = tela(512, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#5f8fcf');
    g.addColorStop(0.47, '#d6e6f4');
    g.addColorStop(0.5, '#8d8f86');
    g.addColorStop(0.56, '#5d5d55');
    g.addColorStop(1, '#2e2d2a');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // prédios/árvores no horizonte
    let x = 0;
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    while (x < w) {
      const bw = 8 + rnd() * 30, bh = 6 + rnd() * 26;
      c.fillStyle = rnd() < 0.5 ? '#7d8a95' : '#5f6d58';
      c.fillRect(x, h * 0.5 - bh, bw, bh);
      x += bw + rnd() * 10;
    }
    // "sol"/nuvens claras
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.beginPath();
    c.ellipse(w * 0.3, h * 0.18, 26, 10, 0, 0, Math.PI * 2);
    c.fill();
  });
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}

function texturaFarol(): THREE.CanvasTexture {
  return tela(256, 128, (c, w, h) => {
    const contorno = [[0.02, 0.3], [0.1, 0.84], [0.55, 0.98], [0.97, 0.97], [0.99, 0.5], [0.8, 0.1], [0.35, 0.02], [0.06, 0.06]];
    poligonoSuave(c, w, h, contorno);
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#5a6068');
    g.addColorStop(1, '#23262b');
    c.fillStyle = g;
    c.fill();
    c.save();
    c.clip();
    const refletor = (sx: number, sy: number, r: number) => {
      const rg = c.createRadialGradient(sx * w, (1 - sy) * h, 2, sx * w, (1 - sy) * h, r);
      rg.addColorStop(0, '#ffffff');
      rg.addColorStop(0.35, '#e9edf2');
      rg.addColorStop(0.7, '#8d949c');
      rg.addColorStop(1, '#3a3f45');
      c.fillStyle = rg;
      c.beginPath();
      c.arc(sx * w, (1 - sy) * h, r, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = '#c9ced4';
      c.lineWidth = 3;
      c.stroke();
    };
    refletor(0.36, 0.5, 36);
    refletor(0.7, 0.56, 30);
    // DRL / friso cromado
    c.strokeStyle = '#f2f4f6';
    c.lineWidth = 5;
    c.beginPath();
    c.moveTo(w * 0.12, h * 0.8);
    c.quadraticCurveTo(w * 0.5, h * 0.95, w * 0.9, h * 0.78);
    c.stroke();
    c.restore();
    poligonoSuave(c, w, h, contorno);
    c.strokeStyle = '#0d0e10';
    c.lineWidth = 6;
    c.stroke();
  });
}

function texturaLente(cor: string, claro: string): THREE.CanvasTexture {
  return tela(128, 128, (c, w, h) => {
    retArred(c, 3, 3, w - 6, h - 6, 22);
    c.fillStyle = cor;
    c.fill();
    c.save();
    c.clip();
    for (let y = 10; y < h; y += 14) {
      const g = c.createLinearGradient(0, y, 0, y + 10);
      g.addColorStop(0, claro);
      g.addColorStop(1, cor);
      c.fillStyle = g;
      c.fillRect(0, y, w, 9);
    }
    c.restore();
    retArred(c, 3, 3, w - 6, h - 6, 22);
    c.strokeStyle = '#111';
    c.lineWidth = 6;
    c.stroke();
  });
}

function texturaGrade(forma: number[][], emblema: boolean): THREE.CanvasTexture {
  return tela(256, 96, (c, w, h) => {
    poligonoSuave(c, w, h, forma);
    c.fillStyle = '#0e0f10';
    c.fill();
    c.save();
    c.clip();
    c.strokeStyle = '#2b2d30';
    c.lineWidth = 2;
    for (let y = -h; y < h * 2; y += 10) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y + w * 0.25);
      c.moveTo(0, y + w * 0.25);
      c.lineTo(w, y);
      c.stroke();
    }
    c.restore();
    poligonoSuave(c, w, h, forma);
    c.strokeStyle = emblema ? '#9aa0a6' : '#050505';
    c.lineWidth = 4;
    c.stroke();
    if (emblema) {
      // emblema genérico (sem marca)
      c.fillStyle = '#c5cad0';
      c.beginPath();
      c.ellipse(w / 2, h / 2, 26, 17, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#7d0d14';
      c.beginPath();
      c.ellipse(w / 2, h / 2, 21, 13, 0, 0, Math.PI * 2);
      c.fill();
    }
  });
}

function texturaPlaca(): THREE.CanvasTexture {
  return tela(400, 130, (c, w, h) => {
    c.fillStyle = '#f4f4f2';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#1f3f9a';
    c.fillRect(0, 0, w, 30);
    c.fillStyle = '#fff';
    c.font = 'bold 20px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('BRASIL', w / 2, 16);
    c.fillStyle = '#2a8a3a';
    c.fillRect(w - 44, 6, 30, 19);
    c.fillStyle = '#111';
    c.font = 'bold 78px monospace';
    c.fillText('BRA2E19', w / 2, 84);
    c.strokeStyle = '#222';
    c.lineWidth = 6;
    c.strokeRect(3, 3, w - 6, h - 6);
  });
}

function texturaPneu(): THREE.CanvasTexture {
  const t = tela(256, 64, (c, w, h) => {
    c.fillStyle = '#1d1d1e';
    c.fillRect(0, 0, w, h);
    // banda de rodagem no meio do perfil
    c.fillStyle = '#121213';
    c.fillRect(0, h * 0.3, w, h * 0.4);
    c.strokeStyle = '#060606';
    c.lineWidth = 3;
    for (const v of [0.42, 0.58]) {
      c.beginPath();
      c.moveTo(0, h * v);
      c.lineTo(w, h * v);
      c.stroke();
    }
    c.lineWidth = 2;
    for (let x = 0; x < w; x += 10) {
      c.beginPath();
      c.moveTo(x, h * 0.3);
      c.lineTo(x + 5, h * 0.42);
      c.moveTo(x + 5, h * 0.58);
      c.lineTo(x, h * 0.7);
      c.stroke();
    }
  });
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(6, 1);
  return t;
}

function texturaSaida(): THREE.CanvasTexture {
  return tela(64, 64, (c, w, h) => {
    c.fillStyle = '#101112';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#34363a';
    for (let y = 6; y < h; y += 10) c.fillRect(3, y, w - 6, 4);
  });
}

function texturaRadio(): THREE.CanvasTexture {
  return tela(256, 128, (c, w, h) => {
    c.fillStyle = '#141517';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#05080a';
    retArred(c, 46, 14, 164, 44, 6);
    c.fill();
    c.fillStyle = '#6fc3ff';
    c.font = 'bold 26px monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('FM 98.5', w / 2, 37);
    c.fillStyle = '#2b2d31';
    for (let i = 0; i < 6; i++) {
      retArred(c, 18 + i * 38, 74, 30, 18, 4);
      c.fill();
    }
    c.fillStyle = '#3a3d42';
    c.beginPath();
    c.arc(22, 36, 14, 0, Math.PI * 2);
    c.arc(w - 22, 36, 14, 0, Math.PI * 2);
    c.fill();
    // comandos do ar
    for (let i = 0; i < 3; i++) {
      c.fillStyle = '#26282c';
      c.beginPath();
      c.arc(56 + i * 72, 112, 12, 0, Math.PI * 2);
      c.fill();
    }
  });
}

// ---------------------------------------------------------------------------
// Shaders da carroceria (máscara de janelas, caixas de roda, frisos)
// ---------------------------------------------------------------------------

function glslComum(cg: number, zRF: number, zRT: number): string {
  const f = (n: number) => n.toFixed(4);
  return /* glsl */ `
varying vec3 vPosL;
varying float vV;
const float CG = ${f(cg)};
const float ZRF = ${f(zRF)};
const float ZRT = ${f(zRT)};
const float HR = ${f(H_CAIXA_RODA)};
const float RR = ${f(R_CAIXA_RODA)};
const float ZB = ${f(Z_COLUNA_B)};
const float ZC = ${f(Z_DIVISOR_C)};
float cintura(float z) { return 0.985 + 0.02 * (0.72 - z); }
float zPara(float h) { return 0.72 - 1.75 * (h - 0.965); }
float zFimDLO(float h) { return -1.56 + 0.45 * (h - 1.0); }
// 1 dentro de um vidro (expandido de m metros), 0 fora
float janela(float m) {
  float h = vPosL.y + CG;
  float z = vPosL.z;
  float mv = m * 1.4;
  if (vV > 0.5 - mv && vV < 0.772 + mv && h > cintura(z) + 0.012 - m) {
    if (z < zPara(h) - 0.012 + m && z > zFimDLO(h) - m) {
      if (abs(z - ZB) < 0.045 - m) return 0.0;
      if (abs(z - ZC) < 0.016 - m) return 0.0;
      return 1.0;
    }
  }
  if (vV > 0.785 - mv) {
    if (z < 0.70 + m && z > -0.065 - m) return 1.0;
    if (z < -1.775 + m && z > -1.905 - m) return 1.0;
  }
  return 0.0;
}
bool caixaRoda() {
  if (abs(vPosL.x) < 0.52) return false;
  float h = vPosL.y + CG;
  return length(vec2(vPosL.z - ZRF, h - HR)) < RR || length(vec2(vPosL.z - ZRT, h - HR)) < RR;
}
float linha(float d, float w) {
  float fw = max(fwidth(d), 1e-5);
  return 1.0 - smoothstep(w, w + fw * 1.2, abs(d));
}
`;
}

const VERT_DECL = 'attribute float aV;\nvarying vec3 vPosL;\nvarying float vV;\n';
function injetarVertice(s: { vertexShader: string }): void {
  s.vertexShader = VERT_DECL + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vPosL = position; vV = aV;');
}

const FRAG_CORPO = /* glsl */ `
  float hh = vPosL.y + CG;
  float plast = 0.0;
  vec3 cor = diffuseColor.rgb;
  if (gl_FrontFacing) {
    float zz = vPosL.z;
    bool ladoVidro = vV > 0.5 && vV < 0.75 && hh > cintura(zz);
    if (janela(0.016) > 0.5) { cor = vec3(0.012); plast = 0.55; }
    else if (ladoVidro && (abs(zz - ZB) < 0.05 || abs(zz - ZC) < 0.03)) { cor = vec3(0.01); plast = 0.4; }
    else if ((vV < 0.32 && hh < 0.33) || (zz < -1.80 && hh < 0.40) || (zz > 1.48 && hh < 0.33)) { cor = vec3(0.018); plast = 1.0; }
    else {
      float ln = 0.0;
      if (vV > 0.2 && vV < 0.52 && abs(vPosL.x) > 0.5) {
        if (hh > 0.33 && hh < cintura(zz)) {
          ln = max(ln, linha(zz - 0.545, 0.0016));
          ln = max(ln, linha(zz - (-0.60), 0.0016));
          if (hh > 0.698) ln = max(ln, linha(zz - (-1.33), 0.0016));
          else if (zz > ZRT) ln = max(ln, linha(length(vec2(zz - ZRT, hh - HR)) - 0.405, 0.0016));
        }
        // portinhola do tanque (lado direito, −X)
        if (vPosL.x < 0.0) ln = max(ln, linha(length(vec2(zz + 1.6, hh - 0.86)) - 0.06, 0.0014));
      }
      // capô
      if (zz > 0.72 && zz < 1.47) ln = max(ln, linha(vV - 0.80, 0.0022));
      // tampa traseira
      if (zz < -1.86 && hh > 0.43 && hh < 1.0) ln = max(ln, linha(abs(vPosL.x) - 0.56, 0.0016));
      if (zz < -1.86 && abs(vPosL.x) < 0.56) ln = max(ln, linha(hh - 0.43, 0.0016));
      cor *= 1.0 - 0.75 * ln;
    }
  } else {
    cor = (vV > 0.80 && vPosL.z < -0.05 && vPosL.z > -1.80) ? vec3(${new THREE.Color(COR_FORRO).toArray().map((n) => n.toFixed(3)).join(',')})
                                        : vec3(${new THREE.Color(COR_ACABAMENTO).toArray().map((n) => n.toFixed(3)).join(',')});
    plast = 1.0;
  }
  diffuseColor.rgb = cor;
`;

// ---------------------------------------------------------------------------
// Utilidades de geometria
// ---------------------------------------------------------------------------

/** Deixa só position/normal/uv e não indexada, para poder fundir geometrias. */
function limpar(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  for (const nome of Object.keys(ng.attributes)) if (!['position', 'normal', 'uv'].includes(nome)) ng.deleteAttribute(nome);
  if (!ng.attributes.uv) ng.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((ng.attributes.position.count) * 2), 2));
  return ng;
}

/** Extrusão de um perfil lateral (z, h) ao longo de X, de xMin a xMax, com chanfro arredondado. */
function extrudarPerfil(pts: number[][], xMin: number, xMax: number, cg: number, chanfro = 0.015, suave = true): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1] - cg);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (p.length === 4) s.quadraticCurveTo(p[0], p[1] - cg, p[2], p[3] - cg);
    else s.lineTo(p[0], p[1] - cg);
  }
  s.closePath();
  const prof = xMax - xMin - 2 * chanfro;
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(0.001, prof), bevelEnabled: chanfro > 0, bevelThickness: chanfro, bevelSize: chanfro,
    bevelSegments: 2, curveSegments: 6, bevelOffset: -chanfro,
  });
  g.rotateY(-Math.PI / 2); // forma x → z do carro; extrusão → −x
  g.translate(xMax - chanfro, 0, 0);
  return suave ? toCreasedNormals(g, 0.7) : g;
}

/** Cilindro entre dois pontos. */
function barra(a: V3, b: V3, raio: number, raio2 = raio, seg = 8): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(raio2, raio, d.length(), seg);
  const q = new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), d.clone().normalize());
  g.applyQuaternion(q);
  const m = a.clone().add(b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
}

function transformar(g: THREE.BufferGeometry, pos: V3, rot?: THREE.Euler, esc?: V3): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromEuler(rot ?? new THREE.Euler()), esc ?? v3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

// ---------------------------------------------------------------------------

interface RodaVisual { direcao: THREE.Group; giro: THREE.Group }

export class VisualCarro {
  readonly grupo = new THREE.Group();
  readonly olho = new THREE.Object3D();
  readonly retrovisores: { centro: THREE.Object3D; esq: THREE.Object3D; dir: THREE.Object3D };
  readonly espelhos: { centro: THREE.Mesh; esq: THREE.Mesh; dir: THREE.Mesh };

  private readonly cg: number;
  private readonly rodas: RodaVisual[] = [];
  private readonly volante = new THREE.Group();
  private readonly maos = new THREE.Group();
  private readonly antebracos: THREE.Mesh[] = [];
  private readonly cotovelos: V3[];
  private readonly punhos: V3[];
  private readonly motorista = new THREE.Group();
  private readonly pedais: THREE.Group[] = [];
  private readonly alavanca = new THREE.Group();
  private readonly freioMao = new THREE.Group();
  private alavX = 0;
  private alavZ = 0;
  private freioMaoAng = 0;

  private readonly matPintura: THREE.MeshPhysicalMaterial;
  private readonly matVidro: THREE.MeshStandardMaterial;
  private readonly mFarol: THREE.MeshStandardMaterial;
  private readonly mLanterna: THREE.MeshStandardMaterial;
  private readonly mBreakLight: THREE.MeshStandardMaterial;
  private readonly mRe: THREE.MeshStandardMaterial;
  private readonly mSetaE: THREE.MeshStandardMaterial;
  private readonly mSetaD: THREE.MeshStandardMaterial;
  private readonly faroisLuz: THREE.SpotLight[] = [];
  private readonly brilhoFreio: THREE.PointLight;

  private readonly painelCanvas: HTMLCanvasElement;
  private readonly painelCtx: CanvasRenderingContext2D;
  private readonly painelTex: THREE.CanvasTexture;
  private painelUltimo = -1e9;
  private painelChave = '';
  private readonly matRadio: THREE.MeshBasicMaterial;
  private readonly matPainel: THREE.MeshBasicMaterial;

  private readonly lotes = new Map<THREE.Material, THREE.BufferGeometry[]>();

  constructor(v: Veiculo) {
    const cfg = v.cfg;
    this.cg = cfg.alturaCG;
    const cg = this.cg;
    const Y = (h: number) => h - cg;

    const env = texturaAmbiente();

    // ------------------------------------------------------------ materiais
    this.matPintura = new THREE.MeshPhysicalMaterial({
      color: COR_PINTURA, roughness: 0.36, metalness: 0.18, clearcoat: 0.8, clearcoatRoughness: 0.1,
      envMap: env, envMapIntensity: 0.9, side: THREE.DoubleSide,
    });
    this.matVidro = new THREE.MeshStandardMaterial({
      color: 0x0c1720, roughness: 0.04, metalness: 0.2, envMap: env, envMapIntensity: 1.0,
      transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide,
    });
    const plastico = new THREE.MeshStandardMaterial({ color: COR_PLASTICO, roughness: 0.7 });
    const plasticoBrilho = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.3, envMap: env, envMapIntensity: 0.5 });
    const cromo = new THREE.MeshStandardMaterial({ color: 0xd6dade, roughness: 0.18, metalness: 1, envMap: env });
    const liga = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.3, metalness: 0.85, envMap: env });
    const borracha = new THREE.MeshStandardMaterial({ color: 0x1b1b1c, roughness: 0.92, map: texturaPneu() });
    const freioMat = new THREE.MeshStandardMaterial({ color: 0x4a4b4d, roughness: 0.5, metalness: 0.6 });
    const forroRoda = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 1, side: THREE.DoubleSide });
    const painelMat = new THREE.MeshStandardMaterial({ color: 0x35373b, roughness: 0.8 });
    const painelFaixa = new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.5, metalness: 0.3, envMap: env, envMapIntensity: 0.4 });
    const acab = new THREE.MeshStandardMaterial({ color: COR_ACABAMENTO, roughness: 0.85 });
    const tecido = new THREE.MeshStandardMaterial({ color: 0x4a4c52, roughness: 0.97 });
    const tecidoEsc = new THREE.MeshStandardMaterial({ color: 0x2e2f33, roughness: 0.97 });
    const carpete = new THREE.MeshStandardMaterial({ color: 0x1a1a1b, roughness: 1 });
    const forro = new THREE.MeshStandardMaterial({ color: COR_FORRO, roughness: 0.95 });
    const pele = new THREE.MeshStandardMaterial({ color: COR_PELE, roughness: 0.75 });
    const camisa = new THREE.MeshStandardMaterial({ color: COR_CAMISA, roughness: 0.9 });
    const calca = new THREE.MeshStandardMaterial({ color: 0x2b2f38, roughness: 0.9 });
    const cabelo = new THREE.MeshStandardMaterial({ color: 0x2a1d14, roughness: 0.9 });
    const volanteMat = new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.6 });

    const lampada = (map: THREE.Texture) =>
      new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0x000000, roughness: 0.15, metalness: 0.1, envMap: env, alphaTest: 0.5 });
    this.mFarol = lampada(texturaFarol());
    const texVermelha = texturaLente('#7a0a10', '#c0202a');
    this.mLanterna = lampada(texVermelha);
    this.mBreakLight = lampada(texVermelha);
    this.mRe = lampada(texturaLente('#c9cbcd', '#f4f5f6'));
    const texAmbar = texturaLente('#b8650a', '#ffb347');
    this.mSetaE = lampada(texAmbar);
    this.mSetaD = lampada(texAmbar);
    const matGradeSup = new THREE.MeshStandardMaterial({ map: texturaGrade([[0.02, 0.3], [0.08, 0.9], [0.92, 0.9], [0.98, 0.3], [0.85, 0.06], [0.15, 0.06]], true), roughness: 0.5, alphaTest: 0.5 });
    const matGradeInf = new THREE.MeshStandardMaterial({ map: texturaGrade([[0.0, 0.1], [0.1, 0.95], [0.9, 0.95], [1.0, 0.1]], false), roughness: 0.6, alphaTest: 0.5 });
    const matPlaca = new THREE.MeshStandardMaterial({ map: texturaPlaca(), roughness: 0.4 });

    // ------------------------------------------------------------ carroceria (loft)
    const NS = 88;
    const R = 2 * N_MEIA - 2;
    const pos = new Float32Array(NS * R * 3);
    const atrV = new Float32Array(NS * R);
    const sec = new Float64Array(N_MEIA * 3);
    for (let i = 0; i < NS; i++) {
      const u = i / (NS - 1);
      const z = Z_TRAS + (Z_FRENTE - Z_TRAS) * (u - (0.8 * Math.sin(2 * Math.PI * u)) / (2 * Math.PI));
      secao(z, sec);
      for (let j = 0; j < R; j++) {
        const k = j < N_MEIA ? j : R - j;
        const sx = j < N_MEIA ? 1 : -1;
        const o = (i * R + j) * 3;
        pos[o] = sec[k * 3] * sx;
        pos[o + 1] = Y(sec[k * 3 + 1]);
        pos[o + 2] = z;
        atrV[i * R + j] = sec[k * 3 + 2];
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < NS - 1; i++) {
      for (let j = 0; j < R; j++) {
        const a = i * R + j, b = i * R + ((j + 1) % R), c = (i + 1) * R + j, d = (i + 1) * R + ((j + 1) % R);
        idx.push(a, c, b, b, c, d);
      }
    }
    const geoCorpo = new THREE.BufferGeometry();
    geoCorpo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geoCorpo.setAttribute('aV', new THREE.BufferAttribute(atrV, 1));
    geoCorpo.setIndex(idx);
    geoCorpo.computeVertexNormals();
    // garante normais para fora (topo do teto deve apontar para +Y)
    {
      const n = geoCorpo.attributes.normal as THREE.BufferAttribute;
      if (n.getY(Math.floor(NS / 2) * R + N_MEIA - 1) < 0) {
        for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
        geoCorpo.setIndex(idx);
        geoCorpo.computeVertexNormals();
      }
    }
    const zRF = cfg.eixoDianteiroZ, zRT = cfg.eixoTraseiroZ;
    const comum = glslComum(cg, zRF, zRT);

    this.matPintura.onBeforeCompile = (s) => {
      injetarVertice(s);
      s.fragmentShader = comum + s.fragmentShader
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (janela(0.0) > 0.5 || caixaRoda()) discard;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_CORPO)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.72, plast);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor *= 1.0 - plast;')
        .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n  material.clearcoat *= 1.0 - plast;');
    };
    this.matPintura.customProgramCacheKey = () => 'mobi-carroceria';
    const corpo = new THREE.Mesh(geoCorpo, this.matPintura);
    corpo.castShadow = true;
    corpo.receiveShadow = true;
    const prof = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    prof.onBeforeCompile = (s) => {
      injetarVertice(s);
      s.fragmentShader = comum + s.fragmentShader.replace(
        '#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (janela(0.0) > 0.5 || caixaRoda()) discard;');
    };
    prof.customProgramCacheKey = () => 'mobi-carroceria-prof';
    corpo.customDepthMaterial = prof;
    this.grupo.add(corpo);

    // vidro: mesma superfície, só os triângulos da estufa
    {
      const idxV: number[] = [];
      for (let t = 0; t < idx.length; t += 3) {
        let ok = false;
        for (let q = 0; q < 3; q++) {
          const vi = idx[t + q];
          if (atrV[vi] > 0.45 && pos[vi * 3 + 1] > Y(0.9)) ok = true;
        }
        if (ok) idxV.push(idx[t], idx[t + 1], idx[t + 2]);
      }
      const geoV = new THREE.BufferGeometry();
      geoV.setAttribute('position', geoCorpo.attributes.position);
      geoV.setAttribute('normal', geoCorpo.attributes.normal);
      geoV.setAttribute('aV', geoCorpo.attributes.aV);
      geoV.setIndex(idxV);
      this.matVidro.onBeforeCompile = (s) => {
        injetarVertice(s);
        s.fragmentShader = comum + s.fragmentShader
          .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (janela(0.0) < 0.5) discard;')
          .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a = gl_FrontFacing ? 0.42 : 0.12;');
      };
      this.matVidro.customProgramCacheKey = () => 'mobi-vidro';
      const vidro = new THREE.Mesh(geoV, this.matVidro);
      vidro.renderOrder = 2;
      this.grupo.add(vidro);
    }

    // forro das caixas de roda
    for (const zA of [zRF, zRT]) {
      for (const lado of [1, -1]) {
        const xi = 0.52, xe = MEIA_LARG + 0.01;
        const cil = new THREE.CylinderGeometry(R_CAIXA_RODA, R_CAIXA_RODA, xe - xi, 20, 1, true, -0.1 * Math.PI, 1.2 * Math.PI);
        cil.rotateZ(Math.PI / 2);
        cil.translate((lado * (xi + xe)) / 2, Y(H_CAIXA_RODA), zA);
        this.lote(forroRoda, cil);
        const disco = new THREE.CircleGeometry(R_CAIXA_RODA, 20, -0.1 * Math.PI, 1.2 * Math.PI);
        disco.rotateY((lado * Math.PI) / 2);
        disco.translate(lado * xi, Y(H_CAIXA_RODA), zA);
        this.lote(forroRoda, disco);
      }
    }

    // ------------------------------------------------------------ peças coladas na lataria
    /** Projeta um ponto na lataria ao longo de `dir` (marcha + bisseção no volume implícito). */
    const projetar = (p: V3, dir: V3): V3 | null => {
      const o = p.clone().addScaledVector(dir, -1.2);
      let tAnt = 0;
      for (let t = 0; t <= 2.6; t += 0.012) {
        const q = o.clone().addScaledVector(dir, t);
        if (dentro(q.x, q.y + cg, q.z)) {
          let a = tAnt, b = t;
          for (let k = 0; k < 14; k++) {
            const m = (a + b) / 2;
            const r = o.clone().addScaledVector(dir, m);
            if (dentro(r.x, r.y + cg, r.z)) b = m; else a = m;
          }
          return o.clone().addScaledVector(dir, a);
        }
        tAnt = t;
      }
      return null;
    };
    /** Malha que acompanha a lataria: cantos (s,t) = 00, 10, 11, 01 em (x, h, z). */
    const adesivo = (cantos: number[][], dirArr: number[], mat: THREE.Material, afast = 0.004, bojo = 0, ns = 9, nt = 6) => {
      const dir = v3(dirArr[0], dirArr[1], dirArr[2]).normalize();
      const c = cantos.map(([x, h, z]) => v3(x, Y(h), z));
      const P: V3[] = [];
      for (let j = 0; j < nt; j++) {
        for (let i = 0; i < ns; i++) {
          const s = i / (ns - 1), t = j / (nt - 1);
          const a = c[0].clone().lerp(c[1], s), b = c[3].clone().lerp(c[2], s);
          const q = a.lerp(b, t);
          P.push(projetar(q, dir) ?? q);
        }
      }
      const posA = new Float32Array(ns * nt * 3), uv = new Float32Array(ns * nt * 2);
      for (let j = 0; j < nt; j++) {
        for (let i = 0; i < ns; i++) {
          const k = j * ns + i;
          const pa = P[j * ns + Math.max(0, i - 1)], pb = P[j * ns + Math.min(ns - 1, i + 1)];
          const pc = P[Math.max(0, j - 1) * ns + i], pd = P[Math.min(nt - 1, j + 1) * ns + i];
          const n = pb.clone().sub(pa).cross(pd.clone().sub(pc)).normalize();
          if (n.dot(dir) > 0) n.negate();
          const s = i / (ns - 1), t = j / (nt - 1);
          const off = afast + bojo * Math.sin(Math.PI * s) * Math.sin(Math.PI * t);
          const pp = P[k].clone().addScaledVector(n, off);
          posA.set([pp.x, pp.y, pp.z], k * 3);
          uv.set([s, t], k * 2);
        }
      }
      const ind: number[] = [];
      for (let j = 0; j < nt - 1; j++) {
        for (let i = 0; i < ns - 1; i++) {
          const a = j * ns + i, b = a + 1, cc = a + ns, d = cc + 1;
          ind.push(a, b, d, a, d, cc);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(posA, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(ind);
      g.computeVertexNormals();
      const nrm = g.attributes.normal as THREE.BufferAttribute;
      const mid = Math.floor(nt / 2) * ns + Math.floor(ns / 2);
      if (v3(nrm.getX(mid), nrm.getY(mid), nrm.getZ(mid)).dot(dir) > 0) {
        for (let t = 0; t < ind.length; t += 3) [ind[t + 1], ind[t + 2]] = [ind[t + 2], ind[t + 1]];
        g.setIndex(ind);
        g.computeVertexNormals();
      }
      this.lote(mat, g);
    };
    const espelharX = (cantos: number[][]) => cantos.map(([x, h, z]) => [-x, h, z]);
    const dupla = (cantos: number[][], dir: number[], matE: THREE.Material, matD: THREE.Material, afast?: number, bojo?: number, ns?: number, nt?: number) => {
      adesivo(cantos, dir, matE, afast, bojo, ns, nt);
      adesivo(espelharX(cantos), [-dir[0], dir[1], dir[2]], matD, afast, bojo, ns, nt);
    };

    // faróis
    dupla([[0.27, 0.6, 1.6], [0.79, 0.64, 1.3], [0.79, 0.79, 1.3], [0.29, 0.762, 1.6]], [-0.3, 0, -1], this.mFarol, this.mFarol, 0.006, 0.012, 12, 7);
    // grade superior e entrada de ar inferior
    adesivo([[0.27, 0.62, 1.7], [-0.27, 0.62, 1.7], [-0.27, 0.735, 1.7], [0.27, 0.735, 1.7]], [0, 0, -1], matGradeSup, 0.004, 0, 9, 4);
    adesivo([[0.55, 0.27, 1.7], [-0.55, 0.27, 1.7], [-0.5, 0.49, 1.7], [0.5, 0.49, 1.7]], [0, 0, -1], matGradeInf, 0.003, 0, 12, 5);
    adesivo([[-0.2, 0.35, 1.7], [0.2, 0.35, 1.7], [0.2, 0.48, 1.7], [-0.2, 0.48, 1.7]], [0, 0, -1], matPlaca, 0.012, 0, 6, 3);
    // piscas dianteiros (cantos do para-choque) e repetidores laterais
    dupla([[0.6, 0.5, 1.6], [0.77, 0.52, 1.4], [0.77, 0.575, 1.4], [0.6, 0.56, 1.6]], [-0.45, 0, -1], this.mSetaE, this.mSetaD, 0.004, 0.004, 6, 3);
    dupla([[1.2, 0.765, 0.7], [1.2, 0.765, 0.62], [1.2, 0.79, 0.62], [1.2, 0.79, 0.7]], [-1, 0, 0], this.mSetaE, this.mSetaD, 0.004, 0.003, 4, 3);
    // lanternas traseiras: posição/freio, pisca, ré (empilhadas, verticais)
    const lanterna = (h0: number, h1: number, matE: THREE.Material, matD: THREE.Material) =>
      dupla([[0.79, h0, -1.85], [0.54, h0, -2.1], [0.54, h1, -2.1], [0.79, h1, -1.85]], [-0.2, 0, 1], matE, matD, 0.006, 0.008, 7, 5);
    lanterna(0.885, 1.02, this.mLanterna, this.mLanterna);
    lanterna(0.8, 0.875, this.mSetaE, this.mSetaD);
    lanterna(0.715, 0.79, this.mRe, this.mRe);
    // freio na tampa (break-light) e placa traseira
    adesivo([[0.15, 1.355, -2.1], [-0.15, 1.355, -2.1], [-0.15, 1.378, -2.1], [0.15, 1.378, -2.1]], [0, 0.15, 1], this.mBreakLight, 0.006, 0, 5, 3);
    adesivo([[0.2, 0.56, -2.1], [-0.2, 0.56, -2.1], [-0.2, 0.69, -2.1], [0.2, 0.69, -2.1]], [0, 0, 1], matPlaca, 0.006, 0, 6, 3);
    // maçanetas
    for (const zc of [-0.33, -1.13]) {
      for (const lado of [1, -1]) {
        const p = projetar(v3(lado * 1.2, Y(0.9), zc), v3(-lado, 0, 0));
        if (!p) continue;
        const g = new RoundedBoxGeometry(0.03, 0.032, 0.15, 2, 0.012);
        g.translate(p.x + lado * 0.004, p.y, p.z);
        this.lote(plasticoBrilho, g);
      }
    }
    // palhetas do limpador (apoiadas na base do para-brisa)
    for (const [xa, xb] of [[-0.42, 0.12], [0.18, 0.66]]) {
      const pa = projetar(v3(xa, Y(1.6), 0.62), v3(0, -1, 0));
      const pb = projetar(v3(xb, Y(1.6), 0.6), v3(0, -1, 0));
      if (!pa || !pb) continue;
      pa.y += 0.014;
      pb.y += 0.014;
      this.lote(plastico, barra(pa, pb, 0.008, 0.008, 6));
    }
    // antena
    this.lote(plastico, barra(v3(0, Y(1.47), -1.5), v3(0, Y(1.62), -1.72), 0.005, 0.003, 5));
    this.lote(plastico, transformar(new RoundedBoxGeometry(0.05, 0.03, 0.08, 2, 0.012), v3(0, Y(1.485), -1.5)));

    // ------------------------------------------------------------ retrovisores externos
    const zEsp = 0.6, hEsp = 1.03;
    const espelhoMat = () => new THREE.MeshBasicMaterial({ color: 0xd9dee3, map: null });
    const pontos = {} as { esq: THREE.Object3D; dir: THREE.Object3D };
    const superficies = {} as { esq: THREE.Mesh; dir: THREE.Mesh };
    for (const lado of [1, -1]) {
      const xEsp = lado * 0.9;
      const guinadaVidro = lado > 0 ? 0.2 : -0.36;
      const carcaca = new THREE.Group();
      carcaca.position.set(xEsp, Y(hEsp), zEsp);
      carcaca.rotation.set(0, Math.PI + guinadaVidro, 0);
      carcaca.updateMatrix();
      const casca = new RoundedBoxGeometry(0.19, 0.115, 0.085, 2, 0.035);
      casca.translate(0, 0, -0.04);
      casca.applyMatrix4(carcaca.matrix);
      this.lote(plastico, casca);
      this.lote(plastico, barra(v3(lado * 0.77, Y(0.985), 0.6), v3(lado * 0.84, Y(1.0), 0.61), 0.022, 0.018, 8));
      const sup = new THREE.Mesh(new THREE.PlaneGeometry(0.165, 0.093), espelhoMat());
      sup.position.set(0, 0, 0.0035);
      carcaca.add(sup);
      this.grupo.add(carcaca);
      const pt = new THREE.Object3D();
      pt.position.set(xEsp, Y(hEsp), zEsp - 0.01);
      pt.rotation.y = Math.PI - lado * 0.12; // olhando para trás e um pouco para fora
      this.grupo.add(pt);
      if (lado > 0) { pontos.esq = pt; superficies.esq = sup; } else { pontos.dir = pt; superficies.dir = sup; }
    }

    // ------------------------------------------------------------ rodas
    const rRoda = cfg.roda.raio;
    const esc = rRoda / 0.292;
    const perfilPneu = [
      [0.18, -0.075], [0.205, -0.084], [0.24, -0.088], [0.266, -0.085], [0.282, -0.076], [0.29, -0.058], [0.292, -0.03],
      [0.292, 0.03], [0.29, 0.058], [0.282, 0.076], [0.266, 0.085], [0.24, 0.088], [0.205, 0.084], [0.18, 0.075],
    ].map(([r, y]) => new THREE.Vector2(r * esc, y));
    const geoPneu = new THREE.LatheGeometry(perfilPneu, 32);
    geoPneu.rotateZ(Math.PI / 2);
    const perfilAro = [[0.172, -0.072], [0.166, -0.06], [0.164, 0.05], [0.17, 0.062], [0.181, 0.066], [0.183, 0.074], [0.176, 0.078]]
      .map(([r, y]) => new THREE.Vector2(r * esc, y));
    const geoAro = new THREE.LatheGeometry(perfilAro, 24);
    geoAro.rotateZ(Math.PI / 2);
    // face da roda de liga: disco com 5 janelas
    const face = new THREE.Shape();
    face.absarc(0, 0, 0.168 * esc, 0, Math.PI * 2, false);
    const nRaios = 5, meiaRaio = 0.019;
    for (let k = 0; k < nRaios; k++) {
      const a0 = (k / nRaios) * Math.PI * 2, a1 = ((k + 1) / nRaios) * Math.PI * 2;
      const ro = 0.143 * esc, ri = 0.056 * esc;
      const dO = Math.asin(meiaRaio / ro), dI = Math.asin(meiaRaio / ri);
      const furo = new THREE.Path();
      furo.absarc(0, 0, ro, a0 + dO, a1 - dO, false);
      furo.absarc(0, 0, ri, a1 - dI, a0 + dI, true);
      furo.closePath();
      face.holes.push(furo);
    }
    let geoFace: THREE.BufferGeometry = new THREE.ExtrudeGeometry(face, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.007, bevelSize: 0.005, bevelSegments: 1, curveSegments: 8 });
    geoFace = toCreasedNormals(geoFace, 0.6);
    geoFace.rotateY(Math.PI / 2);
    geoFace.translate(0.045, 0, 0);
    const geoCubo = new THREE.CylinderGeometry(0.04 * esc, 0.05 * esc, 0.03, 16);
    geoCubo.rotateZ(-Math.PI / 2);
    geoCubo.translate(0.07, 0, 0);
    const geoDisco = new THREE.CylinderGeometry(0.125 * esc, 0.125 * esc, 0.02, 20);
    geoDisco.rotateZ(Math.PI / 2);
    geoDisco.translate(-0.01, 0, 0);
    const geoPinca = new THREE.BoxGeometry(0.05, 0.09, 0.06);
    geoPinca.translate(0.0, 0.08 * esc, -0.07 * esc);
    for (let i = 0; i < 4; i++) {
      const esquerda = i % 2 === 0;
      const direcao = new THREE.Group();
      const giro = new THREE.Group();
      const ladoG = new THREE.Group();
      if (!esquerda) ladoG.rotation.y = Math.PI;
      const pneu = new THREE.Mesh(geoPneu, borracha);
      pneu.castShadow = true;
      ladoG.add(pneu, new THREE.Mesh(geoAro, liga), new THREE.Mesh(geoFace, liga), new THREE.Mesh(geoCubo, plasticoBrilho));
      giro.add(ladoG);
      const fixo = new THREE.Group();
      if (!esquerda) fixo.rotation.y = Math.PI;
      fixo.add(new THREE.Mesh(geoDisco, freioMat), new THREE.Mesh(geoPinca, freioMat));
      direcao.add(giro, fixo);
      this.grupo.add(direcao);
      this.rodas.push({ direcao, giro });
    }

    // ------------------------------------------------------------ luzes reais
    for (const lado of [1, -1]) {
      const s = new THREE.SpotLight(0xfff1d8, 0, 45, 0.5, 0.6, 1.3);
      s.position.set(lado * 0.55, Y(0.7), 1.55);
      s.target.position.set(lado * 0.9, Y(0.1), 14);
      s.castShadow = false;
      this.grupo.add(s, s.target);
      this.faroisLuz.push(s);
    }
    this.brilhoFreio = new THREE.PointLight(0xff1a10, 0, 3, 2);
    this.brilhoFreio.position.set(0, Y(0.55), Z_TRAS - 0.5);
    this.grupo.add(this.brilhoFreio);

    // ------------------------------------------------------------ interior
    // Painel (perfil lateral extrudado de porta a porta)
    this.lote(painelMat, extrudarPerfil([
      [0.72, 0.97], [0.45, 1.0, 0.3, 1.0], [0.2, 0.995, 0.155, 0.93], [0.15, 0.85],
      [0.17, 0.7], [0.3, 0.56], [0.62, 0.52], [0.72, 0.62],
    ], -0.7, 0.7, cg, 0.02));
    // faixa decorativa no painel
    this.lote(painelFaixa, extrudarPerfil([[0.17, 0.835], [0.145, 0.835], [0.146, 0.79], [0.172, 0.79]], -0.66, 0.66, cg, 0.006, false));
    // capela do quadro de instrumentos
    this.lote(painelMat, extrudarPerfil([
      [0.34, 0.99], [0.28, 1.06, 0.15, 1.065], [0.085, 1.065, 0.085, 1.04], [0.12, 1.025], [0.25, 1.02], [0.3, 0.99],
    ], X_MOT - 0.2, X_MOT + 0.2, cg, 0.015));
    // quadro de instrumentos
    this.painelCanvas = document.createElement('canvas');
    this.painelCanvas.width = 512;
    this.painelCanvas.height = 224;
    this.painelCtx = this.painelCanvas.getContext('2d')!;
    this.painelTex = new THREE.CanvasTexture(this.painelCanvas);
    this.painelTex.colorSpace = THREE.SRGBColorSpace;
    this.painelTex.anisotropy = 4;
    this.matPainel = new THREE.MeshBasicMaterial({ map: this.painelTex });
    const quadro = new THREE.Mesh(new THREE.PlaneGeometry(0.33, 0.1444), this.matPainel);
    quadro.position.set(X_MOT, Y(0.915), 0.125);
    quadro.rotation.set(-0.32, Math.PI, 0, 'YXZ');
    this.grupo.add(quadro);
    // central: rádio, saídas de ar
    this.matRadio = new THREE.MeshBasicMaterial({ map: texturaRadio(), color: 0x666666 });
    const radio = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.11), this.matRadio);
    radio.position.set(0, Y(0.745), 0.163);
    radio.rotation.set(-0.35, Math.PI, 0, 'YXZ');
    this.grupo.add(radio);
    const saida = new THREE.MeshStandardMaterial({ map: texturaSaida(), roughness: 0.7 });
    for (const [x, w] of [[0.09, 0.1], [-0.09, 0.1], [0.6, 0.09], [-0.6, 0.09]]) {
      const g = new RoundedBoxGeometry(w, 0.065, 0.02, 2, 0.008);
      g.rotateX(0.0);
      g.translate(x, Y(0.9), 0.152);
      this.lote(saida, g);
    }
    // coluna de direção
    const centroVol = v3(X_MOT, Y(VOLANTE_H), VOLANTE_Z);
    const eixoVol = v3(0, -Math.sin(VOLANTE_INCL), Math.cos(VOLANTE_INCL)); // aponta para o painel
    this.lote(acab, barra(centroVol.clone().addScaledVector(eixoVol, 0.05), centroVol.clone().addScaledVector(eixoVol, 0.3), 0.045, 0.06, 12));
    this.lote(plastico, barra(centroVol.clone().addScaledVector(eixoVol, 0.08).add(v3(0.06, 0, 0)), centroVol.clone().addScaledVector(eixoVol, 0.11).add(v3(0.13, 0.0, 0)), 0.008, 0.008, 6));
    this.lote(plastico, barra(centroVol.clone().addScaledVector(eixoVol, 0.08).add(v3(-0.06, 0, 0)), centroVol.clone().addScaledVector(eixoVol, 0.11).add(v3(-0.13, 0.0, 0)), 0.008, 0.008, 6));

    // volante
    this.volante.position.copy(centroVol);
    {
      const aro = new THREE.Mesh(new THREE.TorusGeometry(VOLANTE_R, 0.017, 10, 40), volanteMat);
      const geoRaio = (ang: number) => {
        const a = v3(Math.cos(ang) * 0.05, Math.sin(ang) * 0.05, 0.012);
        const b = v3(Math.cos(ang) * (VOLANTE_R - 0.01), Math.sin(ang) * (VOLANTE_R - 0.01), -0.004);
        return limpar(barra(a, b, 0.016, 0.012, 8));
      };
      const raios = new THREE.Mesh(mergeGeometries([geoRaio(0), geoRaio(Math.PI), geoRaio(-Math.PI / 2)]), volanteMat);
      raios.scale.set(1, 0.7, 1);
      const cubo = new THREE.Mesh(new RoundedBoxGeometry(0.13, 0.09, 0.05, 2, 0.022), volanteMat);
      cubo.position.z = 0.015;
      const emb = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.006, 14), new THREE.MeshStandardMaterial({ color: 0x7a1016, roughness: 0.35, metalness: 0.5 }));
      emb.rotation.x = Math.PI / 2;
      emb.position.set(0, 0.005, -0.012);
      const marca = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.02, 0.036), new THREE.MeshStandardMaterial({ color: 0x8a8d92, roughness: 0.5 }));
      marca.position.set(0, VOLANTE_R, 0);
      this.volante.add(aro, raios, cubo, emb, marca);
    }
    this.grupo.add(this.volante);

    // mãos (seguram em 9 e 3 h) + antebraços
    this.maos.position.copy(centroVol);
    for (const lado of [1, -1]) {
      const mao = new THREE.Group();
      mao.position.set(lado * VOLANTE_R, 0, -0.008);
      const punho = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.095, 0.055, 2, 0.024), pele);
      punho.position.set(lado * 0.004, 0, -0.012);
      const dedao = new THREE.Mesh(new THREE.CapsuleGeometry(0.011, 0.035, 3, 6), pele);
      dedao.position.set(-lado * 0.022, 0.03, -0.03);
      dedao.rotation.z = lado * 0.9;
      mao.add(punho, dedao);
      this.maos.add(mao);
    }
    this.grupo.add(this.maos);
    this.punhos = [v3(VOLANTE_R + 0.015, -0.03, -0.055), v3(-VOLANTE_R - 0.015, -0.03, -0.055)];
    this.cotovelos = [v3(X_MOT + 0.25, Y(0.78), -0.36), v3(X_MOT - 0.25, Y(0.78), -0.36)];
    for (let k = 0; k < 2; k++) {
      const g = new THREE.CylinderGeometry(0.036, 0.044, 1, 12);
      g.translate(0, 0.5, 0);
      const m = new THREE.Mesh(g, camisa);
      this.antebracos.push(m);
      this.grupo.add(m);
    }

    // espelho interno
    let espCentro: THREE.Mesh;
    let ptCentro: THREE.Object3D;
    {
      const g = new THREE.Group();
      g.position.set(0, Y(1.315), -0.01);
      g.rotation.set(0.08, Math.PI - 0.19, 0, 'YXZ');
      g.updateMatrix();
      const casca = new RoundedBoxGeometry(0.23, 0.07, 0.035, 2, 0.015);
      casca.translate(0, 0, -0.016);
      casca.applyMatrix4(g.matrix);
      this.lote(plastico, casca);
      this.lote(plastico, barra(v3(0, Y(1.335), 0.0), v3(0, Y(topo(0.04) - 0.02), 0.04), 0.009, 0.014, 8));
      espCentro = new THREE.Mesh(new THREE.PlaneGeometry(0.212, 0.054), espelhoMat());
      espCentro.position.z = 0.0025;
      g.add(espCentro);
      this.grupo.add(g);
      ptCentro = new THREE.Object3D();
      ptCentro.position.set(0, Y(1.315), -0.02);
      ptCentro.rotation.set(0.05, Math.PI, 0, 'YXZ');
      this.grupo.add(ptCentro);
    }
    this.retrovisores = { centro: ptCentro, esq: pontos.esq, dir: pontos.dir };
    this.espelhos = { centro: espCentro, esq: superficies.esq, dir: superficies.dir };

    // para-sóis
    for (const x of [X_MOT, -X_MOT]) {
      const g = new RoundedBoxGeometry(0.36, 0.018, 0.16, 2, 0.008);
      g.rotateX(-0.15);
      g.translate(x, Y(1.405), -0.2);
      this.lote(forro, g);
    }

    // console central (túnel), alavanca de câmbio e freio de mão
    this.lote(acab, extrudarPerfil([
      [0.2, 0.6], [0.14, 0.5], [0.05, 0.44], [-0.62, 0.43], [-0.66, 0.3], [0.3, 0.29],
    ], -0.11, 0.11, cg, 0.02));
    this.lote(tecidoEsc, transformar(new THREE.CylinderGeometry(0.05, 0.075, 0.05, 14), v3(0, Y(0.465), -0.03)));
    this.alavanca.position.set(0, Y(0.46), -0.03);
    {
      const haste = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.011, 0.2, 8), cromo);
      haste.position.y = 0.1;
      const coifa = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.08, 12, 1, true), tecidoEsc);
      coifa.position.y = 0.03;
      const bola = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), volanteMat);
      bola.scale.set(1, 0.95, 1.1);
      bola.position.y = 0.21;
      this.alavanca.add(haste, coifa, bola);
    }
    this.grupo.add(this.alavanca);
    this.freioMao.position.set(0, Y(0.45), -0.52);
    {
      const ala = new THREE.Mesh(new RoundedBoxGeometry(0.035, 0.03, 0.26, 2, 0.012), volanteMat);
      ala.position.z = 0.13;
      const bot = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.01, 8), cromo);
      bot.rotation.x = Math.PI / 2;
      bot.position.set(0, 0.0, 0.262);
      this.freioMao.add(ala, bot);
    }
    this.grupo.add(this.freioMao);

    // pedais (embreagem, freio, acelerador — da esquerda p/ a direita do motorista)
    for (const [x, larg] of [[X_MOT + 0.12, 0.07], [X_MOT - 0.01, 0.075], [X_MOT - 0.15, 0.05]]) {
      const p = new THREE.Group();
      p.position.set(x, Y(0.68), 0.5);
      const braco = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.33, 0.015), freioMat);
      braco.position.y = -0.165;
      const sapata = new THREE.Mesh(new RoundedBoxGeometry(larg, larg === 0.05 ? 0.11 : 0.06, 0.018, 2, 0.006), volanteMat);
      sapata.position.set(0, -0.33, -0.01);
      sapata.rotation.x = -0.25;
      p.add(braco, sapata);
      this.pedais.push(p);
      this.grupo.add(p);
    }

    // assoalho, parede corta-fogo, porta-pacotes
    this.lote(carpete, transformar(new THREE.PlaneGeometry(1.42, 2.2), v3(0, Y(0.285), -0.55), new THREE.Euler(-Math.PI / 2, 0, 0)));
    this.lote(carpete, transformar(new THREE.PlaneGeometry(1.42, 0.4), v3(0, Y(0.42), 0.6), new THREE.Euler(-0.75, 0, 0)));
    this.lote(acab, transformar(new RoundedBoxGeometry(1.32, 0.02, 0.27, 2, 0.008), v3(0, Y(1.02), -1.76)));

    // bancos
    const banco = (x: number, w: number, zAss: number, ladoTras: boolean) => {
      const ass = new RoundedBoxGeometry(w, 0.13, 0.5, 2, 0.05);
      transformar(ass, v3(x, Y(0.46), zAss), new THREE.Euler(-0.09, 0, 0));
      this.lote(tecido, ass);
      const enc = new RoundedBoxGeometry(w, ladoTras ? 0.52 : 0.62, 0.13, 2, 0.05);
      transformar(enc, v3(x, Y(ladoTras ? 0.78 : 0.82), zAss - 0.33), new THREE.Euler(ladoTras ? -0.2 : -0.27, 0, 0));
      this.lote(tecido, enc);
      if (!ladoTras) {
        const ap = new RoundedBoxGeometry(0.26, 0.17, 0.1, 2, 0.04);
        transformar(ap, v3(x, Y(1.25), zAss - 0.46), new THREE.Euler(-0.2, 0, 0));
        this.lote(tecidoEsc, ap);
        this.lote(cromo, barra(v3(x + 0.07, Y(1.13), zAss - 0.44), v3(x + 0.07, Y(1.18), zAss - 0.45), 0.006));
        this.lote(cromo, barra(v3(x - 0.07, Y(1.13), zAss - 0.44), v3(x - 0.07, Y(1.18), zAss - 0.45), 0.006));
        // laterais do assento (abas)
        for (const s of [1, -1]) {
          const aba = new RoundedBoxGeometry(0.06, 0.1, 0.46, 2, 0.03);
          transformar(aba, v3(x + s * (w / 2 - 0.02), Y(0.53), zAss), new THREE.Euler(-0.09, 0, 0));
          this.lote(tecidoEsc, aba);
        }
      }
    };
    banco(X_MOT, 0.5, -0.45, false);
    banco(-X_MOT, 0.5, -0.45, false);
    banco(0, 1.04, -1.27, true);
    for (const x of [0.32, -0.32]) {
      const ap = new RoundedBoxGeometry(0.24, 0.14, 0.09, 2, 0.035);
      transformar(ap, v3(x, Y(1.13), -1.68), new THREE.Euler(-0.2, 0, 0));
      this.lote(tecidoEsc, ap);
    }

    // forros de porta (por dentro)
    for (const lado of [1, -1]) {
      const xi = lado > 0 ? 0.69 : -0.79, xe = lado > 0 ? 0.79 : -0.69;
      const pts = (z0: number, z1: number) => [[z0, cintura(z0) - 0.005], [z1, cintura(z1) - 0.005], [z1, 0.32], [z0, 0.32]];
      this.lote(acab, extrudarPerfil(pts(0.54, -0.6), xi, xe, cg, 0.02));
      this.lote(acab, extrudarPerfil(pts(-0.64, -1.03), xi, xe, cg, 0.02));
      const xIns = lado * 0.684;
      this.lote(tecido, transformar(new RoundedBoxGeometry(0.02, 0.2, 0.75, 2, 0.008), v3(xIns, Y(0.78), -0.06)));
      this.lote(tecido, transformar(new RoundedBoxGeometry(0.02, 0.18, 0.3, 2, 0.008), v3(xIns, Y(0.78), -0.84)));
      this.lote(acab, transformar(new RoundedBoxGeometry(0.07, 0.05, 0.36, 2, 0.02), v3(lado * 0.665, Y(0.66), -0.2)));
      this.lote(cromo, transformar(new RoundedBoxGeometry(0.02, 0.025, 0.08, 2, 0.008), v3(lado * 0.68, Y(0.86), 0.25)));
      // coluna B / revestimento acima da cintura não precisa: a carroceria por dentro já tem cor de forro
    }

    // motorista (corpo e cabeça só aparecem de fora)
    {
      const tronco = new THREE.Mesh(new RoundedBoxGeometry(0.4, 0.56, 0.22, 2, 0.08), camisa);
      tronco.position.set(X_MOT, Y(0.86), -0.66);
      tronco.rotation.x = -0.26;
      const pescoco = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.1, 10), pele);
      pescoco.position.set(X_MOT, Y(1.12), -0.6);
      const cabeca = new THREE.Mesh(new THREE.SphereGeometry(0.105, 18, 14), pele);
      cabeca.scale.set(0.9, 1.1, 1.0);
      cabeca.position.set(X_MOT, Y(1.215), -0.58);
      const cab = new THREE.Mesh(new THREE.SphereGeometry(0.108, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), cabelo);
      cab.scale.set(0.92, 1.1, 1.02);
      cab.position.set(X_MOT, Y(1.225), -0.595);
      cab.rotation.x = -0.35;
      this.motorista.add(tronco, pescoco, cabeca, cab);
      for (const s of [1, -1]) {
        const ombro = v3(X_MOT + s * 0.19, Y(1.02), -0.64);
        const cot = this.cotovelos[s > 0 ? 0 : 1];
        const braco = new THREE.Mesh(barra(ombro, cot, 0.045, 0.04, 10), camisa);
        this.motorista.add(braco);
        const quadril = v3(X_MOT + s * 0.1, Y(0.55), -0.55);
        const joelho = v3(X_MOT + s * 0.12, Y(0.62), -0.08);
        const pe = v3(X_MOT + s * 0.12 - 0.04, Y(0.33), 0.38);
        this.motorista.add(new THREE.Mesh(barra(quadril, joelho, 0.075, 0.06, 10), calca));
        this.motorista.add(new THREE.Mesh(barra(joelho, pe, 0.055, 0.045, 10), calca));
      }
    }
    this.grupo.add(this.motorista);

    // olho do motorista
    this.olho.position.set(X_MOT, Y(H_OLHO), Z_OLHO);
    this.grupo.add(this.olho);

    // funde as peças estáticas por material (poucas draw calls)
    for (const [mat, geos] of this.lotes) {
      const g = mergeGeometries(geos.map(limpar));
      if (!g) continue;
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      m.castShadow = mat === plastico || mat === forroRoda;
      this.grupo.add(m);
    }
    this.lotes.clear();

    this.desenharPainel(null);
  }

  private lote(mat: THREE.Material, g: THREE.BufferGeometry): void {
    let l = this.lotes.get(mat);
    if (!l) this.lotes.set(mat, (l = []));
    l.push(g);
  }

  // ---------------------------------------------------------------- quadro de instrumentos
  private desenharPainel(e: EstadoVisual | null): void {
    const c = this.painelCtx;
    const W = this.painelCanvas.width, H = this.painelCanvas.height;
    const lig = !!e?.ignicao;
    c.fillStyle = '#060708';
    c.fillRect(0, 0, W, H);
    const mostrador = (cx: number, cy: number, r: number, max: number, passo: number, sub: number, rotulo: (v: number) => string, valor: number, vermelhoDe: number, legenda: string) => {
      const g = c.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
      g.addColorStop(0, '#16181b');
      g.addColorStop(1, '#0b0c0d');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = '#8a9096';
      c.lineWidth = 3;
      c.stroke();
      const ang = (v: number) => ((225 - (270 * v) / max) * Math.PI) / 180;
      const corTic = lig ? '#f2f4f5' : '#7c8084';
      for (let v = 0; v <= max + 1e-6; v += sub) {
        const a = ang(v);
        const maior = Math.abs(v / passo - Math.round(v / passo)) < 1e-6;
        const r0 = r * (maior ? 0.78 : 0.86);
        c.strokeStyle = v >= vermelhoDe ? '#e0242a' : corTic;
        c.lineWidth = maior ? 3 : 1.5;
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * r0, cy - Math.sin(a) * r0);
        c.lineTo(cx + Math.cos(a) * r * 0.93, cy - Math.sin(a) * r * 0.93);
        c.stroke();
        if (maior) {
          c.fillStyle = corTic;
          c.font = `bold ${Math.round(r * 0.17)}px sans-serif`;
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillText(rotulo(v), cx + Math.cos(a) * r * 0.6, cy - Math.sin(a) * r * 0.6);
        }
      }
      c.fillStyle = lig ? '#aeb4ba' : '#55595d';
      c.font = `${Math.round(r * 0.13)}px sans-serif`;
      c.fillText(legenda, cx, cy + r * 0.38);
      const a = ang(clamp(valor, 0, max * 1.02));
      c.strokeStyle = '#ff5a1f';
      c.lineWidth = 4;
      c.beginPath();
      c.moveTo(cx - Math.cos(a) * r * 0.12, cy + Math.sin(a) * r * 0.12);
      c.lineTo(cx + Math.cos(a) * r * 0.84, cy - Math.sin(a) * r * 0.84);
      c.stroke();
      c.fillStyle = '#2a2d31';
      c.beginPath();
      c.arc(cx, cy, r * 0.09, 0, Math.PI * 2);
      c.fill();
    };
    const r = 100;
    mostrador(112, 112, r, 7, 1, 0.5, (v) => String(v), (e?.rpm ?? 0) / 1000, 6.5, 'RPM x1000');
    mostrador(W - 112, 112, r, 180, 20, 10, (v) => String(v), Math.abs(e?.velocidadeKmh ?? 0), 999, 'km/h');
    // visor digital (marcha + velocidade)
    c.fillStyle = '#020303';
    retArred(c, W - 150, 150, 76, 34, 5);
    c.fill();
    if (lig) {
      c.fillStyle = '#d7f0ff';
      c.font = 'bold 24px monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(String(Math.round(Math.abs(e!.velocidadeKmh))), W - 112, 168);
      const m = e!.marcha;
      c.fillStyle = '#9ad1ff';
      c.font = 'bold 26px monospace';
      c.fillText(m < 0 ? 'R' : m === 0 ? 'N' : String(m), 112, 170);
    }
    // luzes-espia (coluna central)
    const xc = W / 2;
    const luz = (aceso: boolean, cor: string, desenho: (x: number, y: number) => void, x: number, y: number) => {
      c.save();
      c.globalAlpha = aceso ? 1 : 0.13;
      c.fillStyle = cor;
      c.strokeStyle = cor;
      c.lineWidth = 3;
      desenho(x, y);
      c.restore();
    };
    const seta = (dx: number) => (x: number, y: number) => {
      c.beginPath();
      c.moveTo(x + dx * 14, y);
      c.lineTo(x - dx * 2, y - 11);
      c.lineTo(x - dx * 2, y - 5);
      c.lineTo(x - dx * 13, y - 5);
      c.lineTo(x - dx * 13, y + 5);
      c.lineTo(x - dx * 2, y + 5);
      c.lineTo(x - dx * 2, y + 11);
      c.closePath();
      c.fill();
    };
    const pisca = !!e && e.piscando;
    const setaE = pisca && (e!.seta === 'esquerda' || e!.alerta);
    const setaD = pisca && (e!.seta === 'direita' || e!.alerta);
    luz(setaE, '#34e05a', seta(-1), xc - 22, 26);
    luz(setaD, '#34e05a', seta(1), xc + 22, 26);
    luz(!!e?.farol && lig, '#34e05a', (x, y) => {
      c.beginPath();
      c.arc(x + 4, y, 10, -Math.PI / 2, Math.PI / 2);
      c.closePath();
      c.fill();
      for (let k = -1; k <= 1; k++) {
        c.beginPath();
        c.moveTo(x - 4, y + k * 6);
        c.lineTo(x - 16, y + k * 6 + 4);
        c.stroke();
      }
    }, xc, 66);
    luz(lig && !e!.cinto, '#ff2a2a', (x, y) => {
      c.beginPath();
      c.arc(x, y - 10, 5, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.moveTo(x - 9, y + 12);
      c.quadraticCurveTo(x, y - 6, x + 9, y + 12);
      c.stroke();
      c.beginPath();
      c.moveTo(x - 6, y - 3);
      c.lineTo(x + 8, y + 10);
      c.stroke();
    }, xc - 22, 106);
    luz(lig && e!.freioDeMao, '#ff2a2a', (x, y) => {
      c.beginPath();
      c.arc(x, y, 9, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.arc(x, y, 14, -0.7, 0.7);
      c.stroke();
      c.beginPath();
      c.arc(x, y, 14, Math.PI - 0.7, Math.PI + 0.7);
      c.stroke();
      c.font = 'bold 13px sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('P', x, y + 1);
    }, xc + 22, 106);
    const motorParado = lig && !e!.motorLigado;
    luz(motorParado, '#ff2a2a', (x, y) => {
      c.fillRect(x - 12, y - 7, 24, 15);
      c.fillRect(x - 9, y - 11, 5, 4);
      c.fillRect(x + 4, y - 11, 5, 4);
      c.fillStyle = '#000';
      c.fillRect(x - 8, y - 1, 6, 2);
      c.fillRect(x + 3, y - 1, 6, 2);
      c.fillRect(x + 5, y - 3, 2, 6);
    }, xc - 22, 148);
    luz(motorParado, '#ffae1a', (x, y) => {
      c.beginPath();
      c.moveTo(x - 12, y - 6);
      c.lineTo(x + 6, y - 6);
      c.lineTo(x + 12, y);
      c.lineTo(x + 6, y + 8);
      c.lineTo(x - 12, y + 8);
      c.closePath();
      c.fill();
    }, xc + 22, 148);
    // hodômetro
    c.fillStyle = lig ? '#9fb4c4' : '#33383d';
    c.font = '15px monospace';
    c.textAlign = 'center';
    c.fillText('012345 km', xc, 196);
    this.painelTex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- por quadro
  atualizar(v: Veiculo, e: EstadoVisual): void {
    const t = v.corpo.translation();
    const q = v.corpo.rotation();
    this.grupo.position.set(t.x, t.y, t.z);
    this.grupo.quaternion.set(q.x, q.y, q.z, q.w);

    // rodas
    for (let i = 0; i < 4; i++) {
      const rd = v.rodas[i];
      const g = this.rodas[i];
      g.direcao.position.set(rd.montagem.x, rd.montagem.y - rd.comprimento, rd.montagem.z);
      g.direcao.rotation.set(0, rd.anguloEsterco, 0);
      g.giro.rotation.x = rd.rotacao;
    }

    // volante: + = horário visto pelo motorista (direita)
    this.volante.rotation.set(VOLANTE_INCL, 0, 0);
    this.volante.rotateZ(v.anguloVolante);
    // mãos acompanham até ~100°, depois "escorregam" no aro
    this.maos.rotation.set(VOLANTE_INCL, 0, 0);
    this.maos.rotateZ(clamp(v.anguloVolante, -1.75, 1.75));
    this.maos.updateMatrix();
    for (let k = 0; k < 2; k++) {
      const p = _p.copy(this.punhos[k]).applyMatrix4(this.maos.matrix);
      const d = _d.copy(this.cotovelos[k]).sub(p);
      const m = this.antebracos[k];
      m.position.copy(p);
      m.scale.set(1, d.length(), 1);
      m.quaternion.setFromUnitVectors(_cima, d.normalize());
    }
    this.motorista.visible = !e.cockpit;
    this.matVidro.envMapIntensity = e.cockpit ? 0.25 : 1.0;

    // pedais
    const ped = [e.embreagem, e.freio, e.acelerador];
    for (let k = 0; k < 3; k++) this.pedais[k].rotation.x = 0.22 - clamp(ped[k], 0, 1) * (k === 2 ? 0.32 : 0.42);

    // câmbio em H: 1-2 à esquerda (+X), 3-4 no meio, 5-R à direita
    const m = e.marcha;
    const coluna = m === 1 || m === 2 ? -1 : m === 5 || m === -1 ? 1 : 0;
    const frente = m === 0 ? 0 : m === -1 || m % 2 === 0 ? -1 : 1;
    const alvoZ = coluna * 0.24; // rotação em Z: + inclina para −X (direita do motorista)
    const alvoX = frente * 0.3;
    this.alavZ += (alvoZ - this.alavZ) * 0.35;
    this.alavX += (alvoX - this.alavX) * 0.35;
    this.alavanca.rotation.set(this.alavX, 0, this.alavZ);
    this.freioMaoAng += ((e.freioDeMao ? -0.42 : 0) - this.freioMaoAng) * 0.3;
    this.freioMao.rotation.x = this.freioMaoAng;

    // luzes
    const setaE = e.piscando && (e.seta === 'esquerda' || e.alerta);
    const setaD = e.piscando && (e.seta === 'direita' || e.alerta);
    this.mSetaE.emissive.setHex(setaE ? 0xff8c00 : 0);
    this.mSetaD.emissive.setHex(setaD ? 0xff8c00 : 0);
    this.mSetaE.emissiveIntensity = this.mSetaD.emissiveIntensity = 2.2;
    this.mFarol.emissive.setHex(e.farol ? 0xffffff : 0);
    this.mFarol.emissiveIntensity = 1.3;
    this.mLanterna.emissive.setHex(e.freando ? 0xff2020 : e.farol ? 0x701010 : 0);
    this.mLanterna.emissiveIntensity = e.freando ? 2.4 : 1.4;
    this.mBreakLight.emissive.setHex(e.freando ? 0xff2020 : 0);
    this.mBreakLight.emissiveIntensity = 2.4;
    this.mRe.emissive.setHex(e.re ? 0xffffff : 0);
    this.mRe.emissiveIntensity = 1.4;
    for (const s of this.faroisLuz) s.intensity = e.farol ? 40 : 0;
    this.brilhoFreio.intensity = e.freando ? 0.7 : e.farol ? 0.12 : 0;

    // quadro (no máx. ~12 Hz e só quando muda)
    this.matPainel.color.setScalar(e.ignicao ? 1 : 0.55);
    this.matRadio.color.setScalar(e.ignicao ? 1 : 0.25);
    const agora = performance.now();
    if (agora - this.painelUltimo > 80) {
      const chave = [
        Math.round(e.rpm / 25), Math.round(Math.abs(e.velocidadeKmh) * 2), e.marcha, e.ignicao, e.motorLigado, e.cinto,
        e.freioDeMao, e.farol, e.piscando && (e.seta ?? (e.alerta ? 'a' : '')), e.alerta,
      ].join('|');
      if (chave !== this.painelChave) {
        this.painelChave = chave;
        this.painelUltimo = agora;
        this.desenharPainel(e);
      }
    }
  }
}

const _cima = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
