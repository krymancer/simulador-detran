// Gera src/world/autoescola/divisoria.json: o centro da linha amarela CONTÍNUA que
// separa o anel interno do externo, medido na textura do chão (chao.png).
//
// Para cada ponto da linha central do anel interno, procura o ponto mais próximo do
// anel externo e varre o segmento entre os dois atrás da tinta amarela. Só ficam os
// trechos com tinta em pelo menos MIN_SEGUIDOS amostras seguidas: a linha tracejada
// (pode cruzar) e os cruzamentos (sem linha) ficam de fora.
//
//   node scripts/gerar-divisoria.mjs
import fs from 'node:fs';
import { PNG } from 'pngjs';

const raiz = new URL('../src/world/autoescola/', import.meta.url);
const im = PNG.sync.read(fs.readFileSync(new URL('chao.png', raiz)));
const vias = JSON.parse(fs.readFileSync(new URL('vias.json', raiz), 'utf8'));
const M = 23; // px por metro
const MIN_SEGUIDOS = 6; // ~4 m de tinta seguida = linha contínua

const amarelo = (x, y) => {
  const i = (Math.round(y) * im.width + Math.round(x)) * 4;
  return im.data[i] > 180 && im.data[i + 1] > 160 && im.data[i + 2] < 120;
};
const faixa = (id) => vias.faixas.find((f) => f.id === id).pontos;
const I = faixa('anel_interno');
const E = faixa('anel_externo');

const amostras = I.map((p) => {
  let b = null, bd = Infinity;
  for (const q of E) {
    const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
    if (d < bd) { bd = d; b = q; }
  }
  const sep = Math.sqrt(bd) / M;
  if (sep < 2.8 || sep > 4.6) return null; // anel incoerente aqui (baliza, saídas)
  const ts = [];
  for (let i = 0; i <= 400; i++) {
    const t = i / 400;
    if (amarelo(p[0] + (b[0] - p[0]) * t, p[1] + (b[1] - p[1]) * t)) ts.push(t);
  }
  if (!ts.length) return null;
  const t = (Math.min(...ts) + Math.max(...ts)) / 2;
  const c = [p[0] + (b[0] - p[0]) * t, p[1] + (b[1] - p[1]) * t];
  // normal apontando para o anel interno
  const l = Math.hypot(p[0] - b[0], p[1] - b[1]);
  return { p: c.map((v) => +v.toFixed(1)), n: [+((p[0] - b[0]) / l).toFixed(4), +((p[1] - b[1]) / l).toFixed(4)] };
});

// mantém só sequências longas (linha contínua); a lista é circular
const n = amostras.length;
const manter = new Array(n).fill(false);
for (let i = 0; i < n; i++) {
  if (!amostras[i] || manter[i]) continue;
  let a = i;
  while (amostras[(a - 1 + n) % n] && (a - 1 + n) % n !== i) a = (a - 1 + n) % n;
  const run = [];
  for (let k = a; amostras[k % n] && run.length < n; k++) run.push(k % n);
  if (run.length >= MIN_SEGUIDOS) for (const k of run) manter[k] = true;
}
const pontos = amostras.filter((a, i) => a && manter[i]);
fs.writeFileSync(
  new URL('divisoria.json', raiz),
  JSON.stringify({
    descricao: 'Centro da linha amarela contínua do anel (px da planta) e normal apontando para o anel interno. Gerado por scripts/gerar-divisoria.mjs.',
    pontos,
  }),
);
console.log(`divisoria.json: ${pontos.length} de ${n} amostras (linha contínua)`);
