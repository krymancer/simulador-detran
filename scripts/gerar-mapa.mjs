// Converte a planta da autoescola (imagem vista de cima) em:
//   - src/world/autoescola/chao.png   textura do chão limpa (sem carros desenhados, sem logo; canteiros viram calçada/grama)
//   - src/world/autoescola/campos.png  cobertura de tinta branca/amarela e calçada/grama (shader do chão)
//   - src/world/autoescola/grade.json grade de colisão: quais células são calçada/canteiro (elevadas 15 cm)
//
// Regras:
//   asfalto = pixels escuros (e os carros vermelhos desenhados, que são apagados)
//   canteiro/calçada = regiões claras GRANDES (marcações brancas na pista são pequenas e continuam pintura)
//   meio-fio = linha amarela encostada num canteiro; amarela entre dois asfaltos é só pintura
//   buracos pequenos dentro de canteiros (logo, placas) são preenchidos
//
// Uso: node scripts/gerar-mapa.mjs assets-fonte/mapa-autoescola.png
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const entrada = process.argv[2] ?? 'assets-fonte/mapa-autoescola.png';
const saidaDir = 'src/world/autoescola';
const CELULA = 4; // px por célula da grade de colisão

const img = PNG.sync.read(fs.readFileSync(entrada));
const W = img.width;
const H = img.height;
const N = W * H;
const d = img.data;

const AMARELO = 1, ESCURO = 2, VERMELHO = 3, CLARO = 4;
const classe = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
  const lum = (r + g + b) / 3;
  if (r > 160 && g > 110 && b < 120 && r - b > 90) classe[i] = AMARELO; // amarelo e laranja (postes das placas)
  else if (r > 90 && r > g + 35 && r > b + 35) classe[i] = VERMELHO;
  else if (lum < 120) classe[i] = ESCURO;
  else classe[i] = CLARO;
}

/** Rotula componentes conexos (4-vizinhos) de uma máscara. */
function componentes(mascara) {
  const rot = new Int32Array(N).fill(-1);
  const areas = [];
  const fila = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (!mascara[s] || rot[s] >= 0) continue;
    const id = areas.length;
    let ini = 0, fim = 0;
    fila[fim++] = s;
    rot[s] = id;
    while (ini < fim) {
      const p = fila[ini++];
      const x = p % W, y = (p - x) / W;
      const viz = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      for (const q of viz) {
        if (q >= 0 && mascara[q] && rot[q] < 0) {
          rot[q] = id;
          fila[fim++] = q;
        }
      }
    }
    areas.push(fim);
  }
  return { rot, areas };
}

/** Erosão/dilatação com elemento quadrado (separável). */
function morfo(m, r, dilatar) {
  const tmp = new Uint8Array(N);
  const out = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = dilatar ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(W - 1, Math.max(0, x + k));
        const b = m[y * W + xx];
        if (dilatar ? b : !b) { v = dilatar ? 1 : 0; break; }
      }
      tmp[y * W + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = dilatar ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(H - 1, Math.max(0, y + k));
        const b = tmp[yy * W + x];
        if (dilatar ? b : !b) { v = dilatar ? 1 : 0; break; }
      }
      out[y * W + x] = v;
    }
  }
  return out;
}

// 1) Canteiros: componentes claros grandes, sem as linhas finas grudadas neles.
const claro = new Uint8Array(N);
for (let i = 0; i < N; i++) claro[i] = classe[i] === CLARO ? 1 : 0;
const cc = componentes(claro);
let canteiro = new Uint8Array(N);
for (let i = 0; i < N; i++) canteiro[i] = cc.rot[i] >= 0 && cc.areas[cc.rot[i]] >= 6000 ? 1 : 0;
canteiro = morfo(morfo(canteiro, 6, false), 6, true); // tira linhas finas (faixas de vaga, marcas da baliza)

// 2) Elevado = canteiro + borda da linha amarela que encosta nele (o meio-fio).
const perto = morfo(canteiro, 7, true);
const elevado = new Uint8Array(N);
for (let i = 0; i < N; i++) elevado[i] = canteiro[i] || (classe[i] === AMARELO && perto[i]) ? 1 : 0;

// 3) Tudo que não é a malha viária principal (logo, placas, textos) vira canteiro.
const baixo = new Uint8Array(N);
for (let i = 0; i < N; i++) baixo[i] = elevado[i] ? 0 : 1;
const cb = componentes(baixo);
const maiorArea = Math.max(...cb.areas);
for (let i = 0; i < N; i++) if (baixo[i] && cb.areas[cb.rot[i]] < maiorArea * 0.2) elevado[i] = 1;

// 3b) Placas desenhadas encostadas na pista (o recorte as deixou como “buraco”): força canteiro.
for (const [x0, y0, x1, y1] of [[450, 1358, 585, 1432]]) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) elevado[y * W + x] = 1;
}

// 4) Distância até o asfalto (para pintar calçada perto da pista e grama longe).
const dist = new Int32Array(N).fill(1 << 30);
{
  const fila = new Int32Array(N);
  let ini = 0, fim = 0;
  for (let i = 0; i < N; i++) if (!elevado[i]) { dist[i] = 0; fila[fim++] = i; }
  while (ini < fim) {
    const p = fila[ini++];
    const x = p % W, y = (p - x) / W;
    for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
      if (q >= 0 && dist[q] > dist[p] + 1) { dist[q] = dist[p] + 1; fila[fim++] = q; }
    }
  }
}

// 5) Carros desenhados: caixa de cada mancha vermelha vira asfalto.
let verm = new Uint8Array(N);
for (let i = 0; i < N; i++) verm[i] = classe[i] === VERMELHO && !elevado[i] ? 1 : 0;
verm = morfo(verm, 6, true); // junta as partes do mesmo carro
const cv = componentes(verm);
const caixas = new Map();
for (let i = 0; i < N; i++) {
  const id = cv.rot[i];
  if (id < 0 || cv.areas[id] < 1500) continue;
  const x = i % W, y = (i - x) / W;
  const c = caixas.get(id) ?? { x0: x, y0: y, x1: x, y1: y };
  c.x0 = Math.min(c.x0, x); c.y0 = Math.min(c.y0, y); c.x1 = Math.max(c.x1, x); c.y1 = Math.max(c.y1, y);
  caixas.set(id, c);
}
const apagar = new Uint8Array(N);
for (const c of caixas.values()) {
  for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x;
    if (classe[i] !== AMARELO && !elevado[i]) apagar[i] = 1;
  }
}

// 6) Textura
let semente = 12345;
const rnd = () => ((semente = (semente * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const out = new PNG({ width: W, height: H });
for (let i = 0; i < N; i++) {
  let r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
  const ruido = (rnd() - 0.5) * 14;
  if (elevado[i]) {
    if (classe[i] === AMARELO && dist[i] < 12) { r = 238; g = 214; b = 40; }      // meio-fio pintado
    else if (dist[i] < 40) { r = 196 + ruido; g = 191 + ruido; b = 180 + ruido; } // calçada
    else { r = 96 + ruido; g = 138 + ruido; b = 78 + ruido; }                     // grama
  } else if (apagar[i]) {
    r = g = b = 62 + ruido * 0.5;
  } else if (classe[i] === ESCURO || classe[i] === VERMELHO) {
    r = g = b = 60 + ruido * 0.5; // asfalto uniforme com leve granulado
  }
  out.data[i * 4] = Math.max(0, Math.min(255, r));
  out.data[i * 4 + 1] = Math.max(0, Math.min(255, g));
  out.data[i * 4 + 2] = Math.max(0, Math.min(255, b));
  out.data[i * 4 + 3] = 255;
}

// 7) Grade de colisão (maioria por célula), em RLE por linha: "valor,repeticoes,valor,repeticoes…"
const GW = Math.ceil(W / CELULA);
const GH = Math.ceil(H / CELULA);
const linhas = [];
for (let gy = 0; gy < GH; gy++) {
  const runs = [];
  let atual = -1, n = 0;
  for (let gx = 0; gx < GW; gx++) {
    let soma = 0, tot = 0;
    for (let y = gy * CELULA; y < Math.min(H, (gy + 1) * CELULA); y++)
      for (let x = gx * CELULA; x < Math.min(W, (gx + 1) * CELULA); x++) { soma += elevado[y * W + x]; tot++; }
    const v = soma * 2 >= tot ? 1 : 0;
    if (v === atual) n++;
    else { if (n) runs.push(atual, n); atual = v; n = 1; }
  }
  runs.push(atual, n);
  linhas.push(runs.join(','));
}

// 8) Campos para o shader do chão: cobertura (0..1) de tinta branca (R), tinta amarela (G)
//    e piso elevado (B: 0 asfalto, 0,5 calçada, 1 grama), levemente borrados. O shader corta
//    em 0,5 com antisserrilhado, então as bordas ficam lisas em qualquer distância (em vez
//    de cada pixel da planta virar um quadrado de 4 cm).
const cw = new Float32Array(N), cy = new Float32Array(N), ct = new Float32Array(N);
const sat = (v) => Math.max(0, Math.min(1, v));
for (let i = 0; i < N; i++) {
  if (elevado[i]) {
    if (classe[i] === AMARELO && dist[i] < 12) { cy[i] = 1; ct[i] = 0.5; }
    else ct[i] = dist[i] < 40 ? 0.5 : 1;
    continue;
  }
  if (apagar[i]) continue;
  const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
  const lum = (r + g + b) / 3;
  if (r - b > 60 && r > 90) cy[i] = sat((Math.min(r, g) - 60) / (225 - 60)); // amarelo (e a borda serrilhada dele)
  else if (Math.max(r, g, b) - Math.min(r, g, b) < 40) cw[i] = sat((lum - 64) / (235 - 64)); // branco/cinza neutro
}
const borrar = (f) => {
  const t = new Float32Array(N), o = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    t[i] = 0.25 * f[y * W + Math.max(0, x - 1)] + 0.5 * f[i] + 0.25 * f[y * W + Math.min(W - 1, x + 1)];
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    o[i] = 0.25 * t[Math.max(0, y - 1) * W + x] + 0.5 * t[i] + 0.25 * t[Math.min(H - 1, y + 1) * W + x];
  }
  return o;
};
const campos = new PNG({ width: W, height: H });
{
  const [bw, by, bt] = [borrar(cw), borrar(cy), borrar(ct)];
  for (let i = 0; i < N; i++) {
    campos.data[i * 4] = Math.round(bw[i] * 255);
    campos.data[i * 4 + 1] = Math.round(by[i] * 255);
    campos.data[i * 4 + 2] = Math.round(bt[i] * 255);
    campos.data[i * 4 + 3] = 255;
  }
}

fs.mkdirSync(saidaDir, { recursive: true });
fs.writeFileSync(path.join(saidaDir, 'campos.png'), PNG.sync.write(campos));
fs.writeFileSync(path.join(saidaDir, 'chao.png'), PNG.sync.write(out));
fs.writeFileSync(
  path.join(saidaDir, 'grade.json'),
  JSON.stringify({ larguraPx: W, alturaPx: H, celulaPx: CELULA, colunas: GW, linhas: linhas.length, dados: linhas }),
);
console.log(`ok: ${W}x${H}px, grade ${GW}x${GH}, carros apagados: ${caixas.size}`);
