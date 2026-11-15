// Placas de trânsito brasileiras (CTB / CONTRAN — Manual Brasileiro de
// Sinalização de Trânsito, Vol. I Regulamentação e Vol. II Advertência).
//
// Tudo procedural: a face é desenhada em Canvas 2D (512 px) e aplicada numa
// ShapeGeometry recortada no formato oficial (círculo, octógono, triângulo
// invertido, losango). Verso em chapa cinza, poste galvanizado e abraçadeiras.
//
// Convenções: origem do Group na base do poste, no chão; a face olha para +Z
// local (quem se aproxima vindo de +Z enxerga a placa). Unidades em metros.

import * as THREE from 'three';

export type CodigoPlaca =
  | 'R-1' // Parada obrigatória (octógono vermelho, "PARE")
  | 'R-2' // Dê a preferência (triângulo invertido, borda vermelha)
  | 'R-3' // Sentido proibido
  | 'R-4a' | 'R-4b' // Proibido virar à esquerda / à direita
  | 'R-5a' // Proibido retornar à esquerda
  | 'R-6a' // Proibido estacionar
  | 'R-6c' // Proibido parar e estacionar
  | 'R-19' // Velocidade máxima permitida (usa opts.valor, ex. 30)
  | 'R-24a' // Sentido de circulação da via (seta) — opts.direcao 'esquerda'|'direita'
  | 'R-25a' | 'R-25b' // Vire à esquerda / à direita
  | 'R-26' // Siga em frente
  | 'A-1a' | 'A-1b' // Curva acentuada à esquerda / à direita
  | 'A-2a' | 'A-2b' // Curva à esquerda / à direita
  | 'A-6' // Cruzamento de vias
  | 'A-14' // Semáforo à frente
  | 'A-18' // Saliência ou lombada
  | 'A-32b' // Passagem sinalizada de pedestres
  | 'A-33b'; // Passagem sinalizada de escolares

export interface OpcoesPlaca {
  /** R-19: velocidade em km/h (padrão 40). */
  valor?: number;
  /** R-24a: sentido da seta (padrão 'direita'). */
  direcao?: 'esquerda' | 'direita';
  /** Altura do chão até a borda inferior da placa (padrão 2,1 m). */
  alturaPoste?: number;
  /**
   * Dimensão principal da placa em metros:
   * circulares = diâmetro (padrão 0,60); R-1 = distância entre lados opostos (0,60);
   * R-2 = lado do triângulo (0,75); advertência = lado do losango (0,50).
   */
  tamanho?: number;
}

// ---------------------------------------------------------------------------
// Cores oficiais (aproximação sRGB do padrão Munsell do manual)
// ---------------------------------------------------------------------------
const VERMELHO = '#c4161c';
const BRANCO = '#f7f7f4';
const PRETO = '#141414';
const AMARELO = '#f6b90f';
const VERDE_SEMAFORO = '#1f9a4a';
const FONTE = 'Arial, "Liberation Sans", Helvetica, "DejaVu Sans", sans-serif';

const RES = 512; // resolução da textura da face
type Pt = [number, number];

// ---------------------------------------------------------------------------
// Geometria dos contornos (em "unidades de tela": [-1,1], y para baixo)
// ---------------------------------------------------------------------------
type Formato = 'circulo' | 'octogono' | 'triangulo' | 'losango';

function formatoDe(codigo: CodigoPlaca): Formato {
  if (codigo === 'R-1') return 'octogono';
  if (codigo === 'R-2') return 'triangulo';
  if (codigo.startsWith('A-')) return 'losango';
  return 'circulo';
}

/** Polígono regular de n lados com vértices no raio r, primeiro vértice em ang0. */
function poligonoRegular(n: number, r: number, ang0: number, cy = 0): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = ang0 + (i * 2 * Math.PI) / n;
    pts.push([r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Arredonda os cantos de um polígono convexo (raio rc, em unidades de tela). */
function arredondar(pts: Pt[], rc: number, seg = 5): Pt[] {
  const out: Pt[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[(i + n - 1) % n];
    const b = pts[(i + 1) % n];
    const v1 = norm([a[0] - p[0], a[1] - p[1]]);
    const v2 = norm([b[0] - p[0], b[1] - p[1]]);
    const cosT = v1[0] * v2[0] + v1[1] * v2[1];
    const meio = Math.acos(Math.max(-1, Math.min(1, cosT))) / 2;
    const d = rc / Math.tan(meio); // distância do vértice ao ponto de tangência
    const bis = norm([v1[0] + v2[0], v1[1] + v2[1]]);
    const dc = rc / Math.sin(meio);
    const c: Pt = [p[0] + bis[0] * dc, p[1] + bis[1] * dc];
    const t1: Pt = [p[0] + v1[0] * d, p[1] + v1[1] * d];
    const t2: Pt = [p[0] + v2[0] * d, p[1] + v2[1] * d];
    const a1 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    const a2 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
    let da = a2 - a1;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    for (let s = 0; s <= seg; s++) {
      const ang = a1 + (da * s) / seg;
      out.push([c[0] + rc * Math.cos(ang), c[1] + rc * Math.sin(ang)]);
    }
  }
  return out;
}

function norm(v: Pt): Pt {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/** Escala um polígono em torno de um centro. */
function escalar(pts: Pt[], k: number, cx = 0, cy = 0): Pt[] {
  return pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k] as Pt);
}

const H_TRI = Math.sqrt(3) / 2; // meia altura de triângulo de lado 2 = √3/2·2/2

/** Contorno externo de cada formato, em unidades de tela. */
function contorno(f: Formato): Pt[] {
  switch (f) {
    case 'circulo':
      return poligonoRegular(96, 1, 0);
    case 'octogono':
      // lados planos no topo/base; raio circunscrito = 1
      return arredondar(poligonoRegular(8, 1, Math.PI / 8), 0.05);
    case 'triangulo':
      // invertido: base em cima (y = −√3/2), vértice embaixo (y = +√3/2)
      return arredondar(
        [
          [-1, -H_TRI],
          [1, -H_TRI],
          [0, H_TRI],
        ],
        0.07,
      );
    case 'losango':
      return arredondar(
        [
          [0, -1],
          [1, 0],
          [0, 1],
          [-1, 0],
        ],
        0.06,
      );
  }
}

/** Metros por unidade de tela, a partir do tamanho nominal. */
function escalaMetros(codigo: CodigoPlaca, tamanho?: number): number {
  const f = formatoDe(codigo);
  if (f === 'circulo') return (tamanho ?? 0.6) / 2;
  if (f === 'octogono') return (tamanho ?? 0.6) / 2 / Math.cos(Math.PI / 8);
  if (f === 'triangulo') return (tamanho ?? 0.75) / 2;
  return (tamanho ?? 0.5) / Math.SQRT2; // losango: meia diagonal
}

// ---------------------------------------------------------------------------
// Desenho Canvas 2D
// ---------------------------------------------------------------------------
type Ctx = CanvasRenderingContext2D;

function caminho(ctx: Ctx, pts: Pt[]): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

function preencher(ctx: Ctx, pts: Pt[], cor: string): void {
  caminho(ctx, pts);
  ctx.fillStyle = cor;
  ctx.fill();
}

function disco(ctx: Ctx, r: number, cor: string, x = 0, y = 0): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = cor;
  ctx.fill();
}

/** Ponta de seta (triângulo) com base centrada em (x,y) apontando no ângulo ang. */
function ponta(ctx: Ctx, x: number, y: number, ang: number, comp: number, larg: number): void {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  ctx.beginPath();
  ctx.moveTo(x + c * comp, y + s * comp);
  ctx.lineTo(x - s * (larg / 2), y + c * (larg / 2));
  ctx.lineTo(x + s * (larg / 2), y - c * (larg / 2));
  ctx.closePath();
  ctx.fillStyle = PRETO;
  ctx.fill();
}

function haste(ctx: Ctx, larg: number, desenhar: () => void, junta: CanvasLineJoin = 'round'): void {
  ctx.beginPath();
  desenhar();
  ctx.lineWidth = larg;
  ctx.lineCap = 'butt';
  ctx.lineJoin = junta;
  ctx.strokeStyle = PRETO;
  ctx.stroke();
}

/** Texto centrado em (cx,cy) com altura de maiúscula ~alt e largura máxima. */
function texto(ctx: Ctx, str: string, cx: number, cy: number, alt: number, largMax: number, cor: string, peso = 'bold'): void {
  ctx.save();
  // desenha em pixels para manter a nitidez (fontes minúsculas escaladas borram)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const px = (v: number) => (v * RES) / 2;
  const tamFonte = px(alt) / 0.72; // altura de versal ≈ 0,72 do corpo
  ctx.font = `${peso} ${tamFonte}px ${FONTE}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const m = ctx.measureText(str);
  const kx = Math.min(1, px(largMax) / m.width);
  ctx.translate(px(cx) + RES / 2, px(cy) + RES / 2);
  ctx.scale(kx, 1);
  ctx.fillStyle = cor;
  // compensa o "middle" (inclui descendentes) usando as métricas reais
  const asc = m.actualBoundingBoxAscent;
  const desc = m.actualBoundingBoxDescent;
  ctx.fillText(str, 0, (asc - desc) / 2);
  ctx.restore();
}

// --- Fundos padronizados -------------------------------------------------

const R_ORLA = 0.17; // largura da orla vermelha (unid. de tela, raio = 1)
const R_INT = 1 - R_ORLA;

function fundoRegulamentacao(ctx: Ctx): void {
  disco(ctx, 1.02, VERMELHO);
  disco(ctx, R_INT, BRANCO);
}

/** Tarja diagonal vermelha (do alto-esquerda ao baixo-direita). */
function tarja(ctx: Ctx, invertida = false): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, R_INT + 0.02, 0, Math.PI * 2);
  ctx.clip();
  ctx.rotate(invertida ? -Math.PI / 4 : Math.PI / 4);
  ctx.fillStyle = VERMELHO;
  ctx.fillRect(-1.1, -R_ORLA / 2, 2.2, R_ORLA);
  ctx.restore();
}

function fundoAdvertencia(ctx: Ctx): void {
  const ext = contorno('losango');
  // apótema do losango unitário = 1/√2; orla externa amarela e orla interna preta
  const ap = Math.SQRT1_2;
  preencher(ctx, escalar(ext, 1.04), AMARELO);
  preencher(ctx, escalar(ext, (ap - 0.028) / ap), PRETO);
  preencher(ctx, escalar(ext, (ap - 0.085) / ap), AMARELO);
}

// --- Pictogramas -----------------------------------------------------------

/** Seta "vire à esquerda" (R-25a / R-4a), em unidades de tela. */
function setaVireEsquerda(ctx: Ctx): void {
  const L = 0.2;
  haste(ctx, L, () => {
    ctx.moveTo(0.3, 0.64);
    ctx.lineTo(0.3, 0.02);
    ctx.arc(0.0, 0.02, 0.3, 0, -Math.PI / 2, true);
    ctx.lineTo(-0.12, -0.28);
  });
  ponta(ctx, -0.12, -0.28, Math.PI, 0.36, 0.56);
}

function setaRetorno(ctx: Ctx): void {
  const L = 0.18;
  haste(ctx, L, () => {
    ctx.moveTo(0.27, 0.64);
    ctx.lineTo(0.27, -0.12);
    ctx.arc(0, -0.12, 0.27, 0, Math.PI, true);
    ctx.lineTo(-0.27, 0.12);
  });
  ponta(ctx, -0.27, 0.12, Math.PI / 2, 0.34, 0.5);
}

function setaFrente(ctx: Ctx): void {
  haste(ctx, 0.2, () => {
    ctx.moveTo(0, 0.66);
    ctx.lineTo(0, -0.18);
  });
  ponta(ctx, 0, -0.18, -Math.PI / 2, 0.42, 0.58);
}

function setaHorizontal(ctx: Ctx): void {
  // aponta para a esquerda; espelhar para a direita
  haste(ctx, 0.2, () => {
    ctx.moveTo(0.64, 0);
    ctx.lineTo(-0.2, 0);
  });
  ponta(ctx, -0.2, 0, Math.PI, 0.44, 0.58);
}

function espelhado(ctx: Ctx, sim: boolean, f: () => void): void {
  ctx.save();
  if (sim) ctx.scale(-1, 1);
  f();
  ctx.restore();
}

function curvaAcentuadaEsquerda(ctx: Ctx): void {
  haste(
    ctx,
    0.17,
    () => {
      ctx.moveTo(0.18, 0.56);
      ctx.lineTo(0.18, -0.12);
      ctx.lineTo(-0.14, -0.12);
    },
    'miter',
  );
  ponta(ctx, -0.14, -0.12, Math.PI, 0.32, 0.46);
}

function curvaEsquerda(ctx: Ctx): void {
  haste(ctx, 0.17, () => {
    ctx.moveTo(0.24, 0.6);
    ctx.lineTo(0.24, 0.16);
    ctx.bezierCurveTo(0.24, -0.04, 0.09, -0.06, -0.04, -0.19);
  });
  ponta(ctx, -0.04, -0.19, (-3 * Math.PI) / 4, 0.32, 0.46);
}

function cruzamento(ctx: Ctx): void {
  ctx.fillStyle = PRETO;
  const l = 0.19;
  ctx.fillRect(-l / 2, -0.62, l, 1.24);
  ctx.fillRect(-0.62, -l / 2, 1.24, l);
}

function semaforo(ctx: Ctx): void {
  ctx.fillStyle = PRETO;
  ctx.beginPath();
  ctx.roundRect(-0.19, -0.5, 0.38, 1.0, 0.07);
  ctx.fill();
  disco(ctx, 0.115, VERMELHO, 0, -0.31);
  disco(ctx, 0.115, '#ffd23a', 0, 0);
  disco(ctx, 0.115, VERDE_SEMAFORO, 0, 0.31);
}

function lombada(ctx: Ctx): void {
  ctx.fillStyle = PRETO;
  ctx.fillRect(-0.6, 0.16, 1.2, 0.13);
  ctx.beginPath();
  ctx.ellipse(0, 0.17, 0.32, 0.24, 0, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
}

function faixaZebra(ctx: Ctx, y0: number, y1: number): void {
  ctx.fillStyle = PRETO;
  const n = 5;
  const w = 0.085;
  const passo = 0.14;
  const x0 = -((n - 1) * passo) / 2;
  for (let i = 0; i < n; i++) ctx.fillRect(x0 + i * passo - w / 2, y0, w, y1 - y0);
}

/** Figura humana andando (para a direita). Pés em y=0, altura total ~1. */
function pedestre(ctx: Ctx, x: number, yPe: number, alt: number, mochila = false): void {
  ctx.save();
  ctx.translate(x, yPe);
  ctx.scale(alt, alt);
  ctx.strokeStyle = PRETO;
  ctx.fillStyle = PRETO;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // cabeça
  disco(ctx, 0.105, PRETO, 0.06, -0.9);
  // tronco
  ctx.lineWidth = 0.19;
  ctx.beginPath();
  ctx.moveTo(0.04, -0.72);
  ctx.lineTo(-0.01, -0.38);
  ctx.stroke();
  // pernas
  ctx.lineWidth = 0.13;
  ctx.beginPath();
  ctx.moveTo(-0.01, -0.38);
  ctx.lineTo(0.12, -0.18);
  ctx.lineTo(0.2, 0);
  ctx.moveTo(-0.01, -0.38);
  ctx.lineTo(-0.1, -0.17);
  ctx.lineTo(-0.24, -0.03);
  ctx.stroke();
  // braços
  ctx.lineWidth = 0.1;
  ctx.beginPath();
  ctx.moveTo(0.04, -0.68);
  ctx.lineTo(0.16, -0.52);
  ctx.lineTo(0.22, -0.4);
  ctx.moveTo(0.04, -0.68);
  ctx.lineTo(-0.1, -0.54);
  ctx.lineTo(-0.16, -0.42);
  ctx.stroke();
  if (mochila) {
    ctx.beginPath();
    ctx.roundRect(-0.15, -0.72, 0.13, 0.24, 0.03);
    ctx.fill();
  }
  ctx.restore();
}

function passagemPedestres(ctx: Ctx): void {
  pedestre(ctx, -0.02, 0.29, 0.92);
  faixaZebra(ctx, 0.36, 0.52);
}

function passagemEscolares(ctx: Ctx): void {
  pedestre(ctx, -0.2, 0.27, 0.8, true);
  pedestre(ctx, 0.2, 0.27, 0.6, true);
  // mãos dadas
  ctx.strokeStyle = PRETO;
  ctx.lineWidth = 0.06;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-0.03, -0.05);
  ctx.lineTo(0.12, -0.02);
  ctx.stroke();
  faixaZebra(ctx, 0.35, 0.5);
}

// --- Composição de cada placa ------------------------------------------------

function desenharFace(ctx: Ctx, codigo: CodigoPlaca, opts: OpcoesPlaca): void {
  switch (codigo) {
    case 'R-1': {
      const ext = contorno('octogono');
      const ap = Math.cos(Math.PI / 8);
      preencher(ctx, escalar(ext, 1.04), VERMELHO);
      preencher(ctx, escalar(ext, (ap - 0.035) / ap), BRANCO);
      preencher(ctx, escalar(ext, (ap - 0.09) / ap), VERMELHO);
      texto(ctx, 'PARE', 0, 0, 0.5, 1.45, BRANCO);
      return;
    }
    case 'R-2': {
      const ext = contorno('triangulo');
      // incentro do triângulo invertido: y = −√3/2 + r_in, r_in = √3/3
      const rIn = Math.sqrt(3) / 3;
      const cy = -H_TRI + rIn;
      preencher(ctx, escalar(ext, 1.06, 0, cy), VERMELHO);
      preencher(ctx, escalar(ext, (rIn - 0.24) / rIn, 0, cy), BRANCO);
      return;
    }
    case 'R-3':
      disco(ctx, 1.02, BRANCO);
      disco(ctx, 0.965, VERMELHO);
      ctx.fillStyle = BRANCO;
      ctx.fillRect(-0.66, -0.15, 1.32, 0.3);
      return;
    case 'R-4a':
    case 'R-4b':
      fundoRegulamentacao(ctx);
      espelhado(ctx, codigo === 'R-4b', () => setaVireEsquerda(ctx));
      tarja(ctx);
      return;
    case 'R-5a':
      fundoRegulamentacao(ctx);
      setaRetorno(ctx);
      tarja(ctx);
      return;
    case 'R-6a':
      fundoRegulamentacao(ctx);
      texto(ctx, 'E', 0, 0, 0.92, 1.0, PRETO);
      tarja(ctx);
      return;
    case 'R-6c':
      fundoRegulamentacao(ctx);
      texto(ctx, 'E', 0, 0, 0.92, 1.0, PRETO);
      tarja(ctx);
      tarja(ctx, true);
      return;
    case 'R-19': {
      fundoRegulamentacao(ctx);
      const v = String(Math.round(opts.valor ?? 40));
      texto(ctx, v, 0, -0.1, v.length > 2 ? 0.56 : 0.66, v.length > 2 ? 1.3 : 1.15, PRETO);
      texto(ctx, 'km/h', 0, 0.48, 0.15, 0.6, PRETO);
      return;
    }
    case 'R-24a':
      fundoRegulamentacao(ctx);
      espelhado(ctx, (opts.direcao ?? 'direita') === 'direita', () => setaHorizontal(ctx));
      return;
    case 'R-25a':
    case 'R-25b':
      fundoRegulamentacao(ctx);
      espelhado(ctx, codigo === 'R-25b', () => setaVireEsquerda(ctx));
      return;
    case 'R-26':
      fundoRegulamentacao(ctx);
      setaFrente(ctx);
      return;
    case 'A-1a':
    case 'A-1b':
      fundoAdvertencia(ctx);
      espelhado(ctx, codigo === 'A-1b', () => curvaAcentuadaEsquerda(ctx));
      return;
    case 'A-2a':
    case 'A-2b':
      fundoAdvertencia(ctx);
      espelhado(ctx, codigo === 'A-2b', () => curvaEsquerda(ctx));
      return;
    case 'A-6':
      fundoAdvertencia(ctx);
      cruzamento(ctx);
      return;
    case 'A-14':
      fundoAdvertencia(ctx);
      semaforo(ctx);
      return;
    case 'A-18':
      fundoAdvertencia(ctx);
      lombada(ctx);
      return;
    case 'A-32b':
      fundoAdvertencia(ctx);
      passagemPedestres(ctx);
      return;
    case 'A-33b':
      fundoAdvertencia(ctx);
      passagemEscolares(ctx);
      return;
  }
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------
const cacheTexturas = new Map<string, THREE.CanvasTexture>();
const cacheMateriaisFace = new Map<string, THREE.MeshStandardMaterial>();
const cacheGeoFace = new Map<string, THREE.ShapeGeometry>();
const cacheGeoChapa = new Map<string, THREE.ExtrudeGeometry>();
const cacheGeoPoste = new Map<number, THREE.CylinderGeometry>();

function chaveTextura(codigo: CodigoPlaca, opts: OpcoesPlaca): string {
  if (codigo === 'R-19') return `${codigo}|${Math.round(opts.valor ?? 40)}`;
  if (codigo === 'R-24a') return `${codigo}|${opts.direcao ?? 'direita'}`;
  return codigo;
}

function texturaFace(codigo: CodigoPlaca, opts: OpcoesPlaca): THREE.CanvasTexture {
  const chave = chaveTextura(codigo, opts);
  let tex = cacheTexturas.get(chave);
  if (tex) return tex;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = RES;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(RES / 2, 0, 0, RES / 2, RES / 2, RES / 2);
  desenharFace(ctx, codigo, opts);
  tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  cacheTexturas.set(chave, tex);
  return tex;
}

function materialFace(codigo: CodigoPlaca, opts: OpcoesPlaca): THREE.MeshStandardMaterial {
  const chave = chaveTextura(codigo, opts);
  let m = cacheMateriaisFace.get(chave);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      map: texturaFace(codigo, opts),
      roughness: 0.42,
      metalness: 0,
      // película retrorrefletiva: um leve brilho próprio mantém a placa legível na sombra
      emissive: 0xffffff,
      emissiveMap: texturaFace(codigo, opts),
      emissiveIntensity: 0.18,
    });
    cacheMateriaisFace.set(chave, m);
  }
  return m;
}

const matVerso = new THREE.MeshStandardMaterial({ color: 0x8e9397, metalness: 0.55, roughness: 0.55 });
const matGalvanizado = new THREE.MeshStandardMaterial({ color: 0xb8bcbf, metalness: 0.75, roughness: 0.38 });
const matAbracadeira = new THREE.MeshStandardMaterial({ color: 0x7d8286, metalness: 0.7, roughness: 0.45 });

function formaMetros(f: Formato, S: number): THREE.Shape {
  const pts = contorno(f);
  const shape = new THREE.Shape();
  pts.forEach(([x, y], i) => (i ? shape.lineTo(x * S, -y * S) : shape.moveTo(x * S, -y * S)));
  shape.closePath();
  return shape;
}

function geoFace(f: Formato, S: number): THREE.ShapeGeometry {
  const chave = `${f}|${S.toFixed(4)}`;
  let g = cacheGeoFace.get(chave);
  if (g) return g;
  g = new THREE.ShapeGeometry(formaMetros(f, S), 1);
  // UV: unidade de tela [-1,1] → [0,1]
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / (2 * S) + 0.5, pos.getY(i) / (2 * S) + 0.5);
  uv.needsUpdate = true;
  cacheGeoFace.set(chave, g);
  return g;
}

const ESPESSURA = 0.004; // chapa de aço/alumínio

function geoChapa(f: Formato, S: number): THREE.ExtrudeGeometry {
  const chave = `${f}|${S.toFixed(4)}`;
  let g = cacheGeoChapa.get(chave);
  if (g) return g;
  g = new THREE.ExtrudeGeometry(formaMetros(f, S), { depth: ESPESSURA, bevelEnabled: false, curveSegments: 1 });
  cacheGeoChapa.set(chave, g);
  return g;
}

const R_POSTE = 0.032; // tubo galvanizado de 2½"

function geoPoste(alt: number): THREE.CylinderGeometry {
  const chave = Math.round(alt * 1000);
  let g = cacheGeoPoste.get(chave);
  if (!g) {
    g = new THREE.CylinderGeometry(R_POSTE, R_POSTE, alt, 14, 1, false);
    g.translate(0, alt / 2, 0);
    cacheGeoPoste.set(chave, g);
  }
  return g;
}

const geoTampa = new THREE.SphereGeometry(R_POSTE * 1.05, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
const geoAbracadeira = new THREE.BoxGeometry(0.11, 0.04, 0.05);
const geoTrilho = new THREE.BoxGeometry(1, 0.035, 0.012);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Cria uma placa completa (poste + chapa + face). Origem na base do poste;
 * face voltada para +Z local.
 */
export function criarPlaca(codigo: CodigoPlaca, opts: OpcoesPlaca = {}): THREE.Group {
  const f = formatoDe(codigo);
  const S = escalaMetros(codigo, opts.tamanho);
  const base = opts.alturaPoste ?? 2.1;

  // extensão vertical do contorno (metros, y para cima)
  const yMin = f === 'triangulo' ? -H_TRI * S : -S;
  const yMax = f === 'triangulo' ? H_TRI * S : S;
  const cy = base - yMin; // centro da placa
  const larg = 2 * S;
  const altPlaca = yMax - yMin;

  const g = new THREE.Group();
  g.name = `placa ${codigo}`;

  const altPoste = base + altPlaca - 0.04;
  const poste = new THREE.Mesh(geoPoste(altPoste), matGalvanizado);
  poste.castShadow = true;
  poste.receiveShadow = true;
  g.add(poste);
  const tampa = new THREE.Mesh(geoTampa, matGalvanizado);
  tampa.position.y = altPoste;
  g.add(tampa);

  // a chapa fica à frente do poste, presa por abraçadeiras e trilhos
  const zTraseira = R_POSTE + 0.022;
  const chapa = new THREE.Mesh(geoChapa(f, S), matVerso);
  chapa.position.set(0, cy, zTraseira);
  chapa.castShadow = true;
  chapa.receiveShadow = true;
  g.add(chapa);

  const face = new THREE.Mesh(geoFace(f, S), materialFace(codigo, opts));
  face.position.set(0, cy, zTraseira + ESPESSURA + 0.0006);
  face.receiveShadow = true;
  g.add(face);

  // trilhos horizontais (perfil "ômega") no verso e abraçadeiras no poste
  const fixacoes = [cy - altPlaca * 0.27, cy + altPlaca * 0.27];
  for (const y of fixacoes) {
    // largura útil do contorno nessa altura (losango/triângulo estreitam)
    const yl = (y - cy) / S; // unidades de tela, y para cima
    let meia = 1;
    if (f === 'losango') meia = 1 - Math.abs(yl);
    else if (f === 'triangulo') meia = (yl + H_TRI) / (2 * H_TRI); // vértice embaixo
    else meia = Math.sqrt(Math.max(0, 1 - yl * yl));
    const comp = Math.max(0.08, meia * 2 * S * 0.8);
    const trilho = new THREE.Mesh(geoTrilho, matAbracadeira);
    trilho.scale.x = Math.min(comp, larg * 0.8);
    trilho.position.set(0, y, zTraseira - 0.006);
    g.add(trilho);
    const abr = new THREE.Mesh(geoAbracadeira, matAbracadeira);
    abr.position.set(0, y, 0.004);
    abr.castShadow = true;
    g.add(abr);
  }

  g.userData.colisor = { raio: R_POSTE, altura: altPoste };
  g.userData.codigo = codigo;
  return g;
}

/** Libera texturas/geometrias em cache (ao descarregar o mapa). */
export function descartarCachePlacas(): void {
  cacheTexturas.forEach((t) => t.dispose());
  cacheMateriaisFace.forEach((m) => m.dispose());
  cacheGeoFace.forEach((g) => g.dispose());
  cacheGeoChapa.forEach((g) => g.dispose());
  cacheGeoPoste.forEach((g) => g.dispose());
  cacheTexturas.clear();
  cacheMateriaisFace.clear();
  cacheGeoFace.clear();
  cacheGeoChapa.clear();
  cacheGeoPoste.clear();
}
