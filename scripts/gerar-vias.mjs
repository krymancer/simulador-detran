// Extrai as linhas centrais das faixas da pista da autoescola a partir da textura
// limpa (src/world/autoescola/chao.png) e da grade de calçadas, e grava
// src/world/autoescola/vias.json (coordenadas em px da planta).
//
// Anel: mão dupla separada pela linha amarela. Faixa interna = sentido horário
// (na planta: sobe pela esquerda, vai para a direita em cima…), externa = anti-horário.
// Avenida diagonal: mão única, 3 faixas subindo (de baixo para cima).
//
// Uso: node scripts/gerar-vias.mjs
import fs from 'node:fs';
import { PNG } from 'pngjs';

const img = PNG.sync.read(fs.readFileSync('src/world/autoescola/chao.png'));
const grade = JSON.parse(fs.readFileSync('src/world/autoescola/grade.json', 'utf8'));
const W = img.width, H = img.height, C = grade.celulaPx;
const g = grade.dados.map((l) => {
  const a = l.split(',').map(Number);
  const r = [];
  for (let i = 0; i < a.length; i += 2) for (let k = 0; k < a[i + 1]; k++) r.push(a[i] === 1);
  return r;
});

/** 'R' calçada/fora, 'Y' amarelo pintado, 'A' asfalto (inclui marcas brancas) */
function classe(x, y) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return 'R';
  // estacionamento de baixo à direita fica fora do anel
  if (y > 1352 && x > 905) return 'R';
  // faixa clara fina na borda de cima da planta (não é pista)
  if (y < 16) return 'R';
  if (g[Math.floor(y / C)]?.[Math.floor(x / C)]) return 'R';
  const i = (y * W + x) * 4;
  const r = img.data[i], gg = img.data[i + 1], b = img.data[i + 2];
  if (r > 170 && gg > 140 && b < 120) return 'Y';
  return 'A';
}

// ---------- Anel: raios do centro para fora
const CX = 790, CY = 700;
const LARG_MAX = 95; // px: uma faixa não passa disso (corta onde a pista se abre em cruzamento)
const interno = [], externo = [];
for (let ang = 0; ang < 360; ang += 1.5) {
  const a = (ang * Math.PI) / 180;
  const dx = Math.cos(a), dy = Math.sin(a);
  // marcha de fora para dentro
  const seq = [];
  for (let r = 1150; r > 0; r -= 1) seq.push([r, classe(CX + dx * r, CY + dy * r)]);
  // primeira corrida de asfalto (faixa externa)
  let i = 0;
  while (i < seq.length && seq[i][1] !== 'A') i++;
  if (i >= seq.length) continue;
  const iniA1 = i;
  while (i < seq.length && seq[i][1] === 'A') i++;
  const fimA1 = i; // exclusivo
  // separador amarelo?
  let j = i;
  while (j < seq.length && seq[j][1] === 'Y') j++;
  const temDivisor = j > i && j < seq.length && seq[j][1] === 'A';
  let rExt, rInt;
  if (temDivisor && fimA1 - iniA1 <= LARG_MAX * 1.3) {
    const iniA2 = j;
    let k = j;
    while (k < seq.length && seq[k][1] === 'A' && k - iniA2 < LARG_MAX * 1.3) k++;
    rExt = (seq[iniA1][0] + seq[fimA1 - 1][0]) / 2;
    rInt = (seq[iniA2][0] + seq[k - 1][0]) / 2;
  } else {
    // pista sem divisor (ou cruzamento): divide em duas faixas de LARG_MAX
    const larg = Math.min(fimA1 - iniA1, 2 * LARG_MAX);
    rExt = seq[iniA1][0] - larg * 0.25;
    rInt = seq[iniA1][0] - larg * 0.75;
  }
  externo.push([CX + dx * rExt, CY + dy * rExt]);
  interno.push([CX + dx * rInt, CY + dy * rInt]);
}

/** Remove saltos (pontos fora da curva) e suaviza. */
function suavizar(pts, fechado = true, janela = 2) {
  const n = pts.length;
  // descarta pontos que pulam muito em relação aos vizinhos
  const ok = pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return Math.hypot(p[0] - m[0], p[1] - m[1]) < 30;
  });
  const lim = pts.filter((_, i) => ok[i]);
  const out = [];
  const m = lim.length;
  for (let i = 0; i < m; i++) {
    let sx = 0, sy = 0, c = 0;
    for (let k = -janela; k <= janela; k++) {
      const q = fechado ? lim[(i + k + m) % m] : lim[Math.min(m - 1, Math.max(0, i + k))];
      sx += q[0]; sy += q[1]; c++;
    }
    out.push([Math.round((sx / c) * 10) / 10, Math.round((sy / c) * 10) / 10]);
  }
  return out;
}

// ---------- Diagonal: varre linhas horizontais
function bordasDiagonal(y) {
  // procura o trecho de asfalto que contém a diagonal: começa à direita do canteiro grande
  const xs = [];
  let dentro = false, ini = 0;
  for (let x = 450; x < 1400; x++) {
    const c = classe(x, y);
    const asf = c === 'A';
    if (asf && !dentro) { dentro = true; ini = x; }
    if (!asf && dentro) { dentro = false; xs.push([ini, x - 1]); }
  }
  // a diagonal é o trecho mais largo
  xs.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  return xs[0];
}
const faixasDiag = [[], [], []];
for (let y = 1150; y >= 300; y -= 25) {
  const b = bordasDiagonal(y);
  if (!b) continue;
  const larg = b[1] - b[0];
  for (let f = 0; f < 3; f++) faixasDiag[f].push([Math.round(b[0] + (larg * (f + 0.5)) / 3), y]);
}

// Trecho da baliza (lado esquerdo): a faixa interna ali é a vaga. Quem segue pela
// faixa interna desvia encostando na linha divisória para não bater nas balizas.
const interSuave = suavizar(interno);
const trecho = interSuave.map((p, i) => [p, i]).filter(([p]) => p[1] > 440 && p[1] < 900 && p[0] < 320);
const novosX = trecho.map(([p]) => {
  // acha a linha amarela divisória à esquerda do ponto (a primeira corrida amarela
  // com asfalto dos dois lados e pelo menos 30 px à esquerda: pula as linhas transversais da vaga)
  let x = Math.round(p[0]) - 30;
  while (x > 0 && classe(x, p[1]) !== 'Y') x--;
  return x > 0 ? x - 10 : p[0]; // centro um pouco sobre a divisória: o carro passa raspando a linha, longe das hastes
});
// mediana para tirar picos
trecho.forEach(([p], k) => {
  const viz = novosX.slice(Math.max(0, k - 3), k + 4).sort((a, b) => a - b);
  p[0] = viz[viz.length >> 1];
});

const vias = {
  descricao: 'Linhas centrais das faixas em px da planta. Os pontos estão na ordem do sentido do trânsito.',
  faixas: [
    { id: 'anel_interno', fechada: true, mao: 'dupla', pontos: suavizar(interSuave, true, 1) },
    { id: 'anel_externo', fechada: true, mao: 'dupla', pontos: suavizar(externo).reverse() },
    ...faixasDiag.map((p, i) => ({ id: `diagonal_${i + 1}`, fechada: false, mao: 'unica', pontos: suavizar(p, false, 1) })),
  ],
};
fs.writeFileSync('src/world/autoescola/vias.json', JSON.stringify(vias));
console.log(vias.faixas.map((f) => `${f.id}: ${f.pontos.length} pts`).join(', '));
