import * as THREE from 'three';
import { ALTURA_CALCADA, alturaTerreno, lerGrade, METROS_POR_PX, px } from './autoescola';
import { CodigoPlaca, criarPlaca, OpcoesPlaca } from './placas';
import { criarArvores, criarPredio } from './ambiente';
import grade from './autoescola/grade.json';
import { AREAS_LIVRES_FERROVIA_PX, CORREDOR_FERROVIA } from './ferrovia';

/**
 * Placas (CTB), árvores e prédios da pista da autoescola. Usa canvas, então só
 * roda no navegador. Tudo que tem colisão leva `userData.colisor(es)`, que o
 * parser transforma em sólidos.
 */

interface Placa {
  codigo: CodigoPlaca;
  /** posição na planta (px) */
  x: number;
  y: number;
  /** direção (na planta) para onde a face da placa olha = de onde vêm os motoristas */
  face: [number, number];
  opts?: OpcoesPlaca;
}

// Fluxo assumido: anel no sentido horário (sobe pela esquerda, onde fica a baliza à direita),
// avenida diagonal subindo, rua de baixo em mão dupla.
const DIAG: [number, number] = [0.38, 0.92];
const PLACAS: Placa[] = [
  { codigo: 'A-2b', x: 325, y: 330, face: [0, 1] },            // curva à direita (subindo pela esquerda)
  { codigo: 'A-2b', x: 1470, y: 62, face: [-1, 0] },           // curva à direita (canto superior direito)
  { codigo: 'A-2b', x: 300, y: 1160, face: [1, 0] },           // curva à direita (canto inferior esquerdo, indo para oeste)
  { codigo: 'A-6', x: 540, y: 1392, face: [-1, 0] },           // cruzamento à frente (planta)
  { codigo: 'A-6', x: 810, y: 1138, face: [1, 0] },            // cruzamento à frente (planta)
  { codigo: 'A-14', x: 1000, y: 620, face: DIAG },             // semáforo à frente (subindo a avenida)
  { codigo: 'A-14', x: 1180, y: -12, face: [1, 0] },           // semáforo à frente (faixa de cima, indo para oeste)
  { codigo: 'A-14', x: 300, y: 470, face: [0, 1] },            // semáforo à frente (subindo pela esquerda)
  { codigo: 'A-32b', x: 430, y: 8, face: [-1, 0] },            // passagem de pedestres
  { codigo: 'R-19', x: 258, y: 1000, face: [0, 1], opts: { valor: 30 } },
  { codigo: 'R-19', x: 1530, y: 700, face: [0, -1], opts: { valor: 30 } },
  { codigo: 'R-19', x: 1190, y: 1010, face: DIAG, opts: { valor: 30 } },
  { codigo: 'R-6a', x: 1240, y: 860, face: DIAG },             // proibido estacionar (ao lado das áreas zebradas)
  { codigo: 'R-1', x: 440, y: 1370, face: [-1, 0] },           // PARE antes da passagem de nível (indo para leste)
  { codigo: 'R-1', x: 905, y: 1186, face: [1, 0] },            // PARE antes da passagem de nível (indo para oeste)
];

function gradeElevada() {
  const g = lerGrade();
  const C = grade.celulaPx;
  const elev = (xpx: number, ypx: number) => {
    const cx = Math.floor(xpx / C), cy = Math.floor(ypx / C);
    return cy >= 0 && cy < g.length && cx >= 0 && cx < g[0].length && g[cy][cx];
  };
  /** Todas as células num raio (px) são calçada/canteiro? */
  const livre = (xpx: number, ypx: number, raioPx: number) => {
    for (let dy = -raioPx; dy <= raioPx; dy += C) for (let dx = -raioPx; dx <= raioPx; dx += C) {
      if (dx * dx + dy * dy > raioPx * raioPx) continue;
      const x = xpx + dx, y = ypx + dy;
      if (x < 0 || y < 0 || x >= grade.larguraPx || y >= grade.alturaPx) continue; // fora da planta é grama
      if (!elev(x, y)) return false;
    }
    return true;
  };
  return { elev, livre };
}

export function decorarAutoescola(raiz: THREE.Object3D): void {
  const { elev, livre } = gradeElevada();
  let semente = 7;
  const rnd = () => ((semente = (semente * 16807) % 2147483647) / 2147483647);

  // ---- Placas (empurradas para a calçada se a posição cair no asfalto)
  for (const p of PLACAS) {
    let { x, y } = p;
    if (!elev(x, y)) {
      let melhor: [number, number] | null = null;
      for (let r = 4; r < 60 && !melhor; r += 4)
        for (let a = 0; a < Math.PI * 2 && !melhor; a += Math.PI / 12) {
          const xx = x + Math.cos(a) * r, yy = y + Math.sin(a) * r;
          if (elev(xx, yy)) melhor = [xx, yy];
        }
      if (melhor) [x, y] = melhor;
    }
    const g = criarPlaca(p.codigo, p.opts);
    g.position.copy(px(x, y, ALTURA_CALCADA));
    g.position.y += alturaTerreno(g.position.x, g.position.z);
    g.rotation.y = Math.atan2(p.face[0], p.face[1]);
    g.name = `placa_${p.codigo}`;
    raiz.add(g);
  }

  // ---- Árvores nos canteiros grandes e em volta da pista
  const arvores: { x: number; z: number; y?: number; semente: number }[] = [];
  const passo = 3.2 / METROS_POR_PX;
  for (let y = 0; y < grade.alturaPx; y += passo) {
    for (let x = 0; x < grade.larguraPx; x += passo) {
      const jx = x + (rnd() - 0.5) * passo * 0.8;
      const jy = y + (rnd() - 0.5) * passo * 0.8;
      // corredor da linha férrea e estação ficam sem árvores
      if (AREAS_LIVRES_FERROVIA_PX.some((a) => jx > a.x0 - 25 && jx < a.x1 + 25 && jy > a.y0 - 25 && jy < a.y1 + 25)) continue;
      if (rnd() < 0.5 && livre(jx, jy, 2.6 / METROS_POR_PX)) {
        const w = px(jx, jy);
        arvores.push({ x: w.x, z: w.z, y: ALTURA_CALCADA + alturaTerreno(w.x, w.z), semente: Math.floor(rnd() * 1e6) });
      }
    }
  }
  const largM = grade.larguraPx * METROS_POR_PX;
  const altM = grade.alturaPx * METROS_POR_PX;
  for (let i = 0; i < 160; i++) {
    // anel de 4 a 22 m fora da planta
    const lado = Math.floor(rnd() * 4);
    const d = 4 + rnd() * 18;
    const t = rnd() - 0.5;
    const x = lado < 2 ? t * (largM + 2 * d) : (lado === 2 ? -1 : 1) * (largM / 2 + d);
    const z = lado < 2 ? (lado === 0 ? -1 : 1) * (altM / 2 + d) : t * (altM + 2 * d);
    if (z > 0 && x > CORREDOR_FERROVIA.xMin - 3 && x < CORREDOR_FERROVIA.xMax + 3) continue; // linha férrea saindo para o sul
    arvores.push({ x, z, y: ALTURA_CALCADA, semente: Math.floor(rnd() * 1e6) });
  }
  raiz.add(criarArvores(arvores));

  // ---- Prédios ao redor (cidade ao fundo)
  const predios = new THREE.Group();
  predios.name = 'predios';
  const lados: [number, number, number, number][] = [
    // [x, z, direção ao longo (0 = eixo X, 1 = eixo Z), sinal para fora]
    [0, -(altM / 2 + 34), 0, -1],
    [0, altM / 2 + 34, 0, 1],
    [-(largM / 2 + 34), 0, 1, -1],
    [largM / 2 + 34, 0, 1, 1],
  ];
  for (const [cx, cz, eixo] of lados) {
    const comp = (eixo === 0 ? largM : altM) + 70;
    for (let s = -comp / 2; s < comp / 2; ) {
      const larg = 10 + rnd() * 12;
      const alt = 8 + rnd() * 26;
      const prof = 10 + rnd() * 8;
      const p = criarPredio(larg, alt, prof, Math.floor(rnd() * 1e6));
      const meio = s + larg / 2;
      // a linha férrea sai para o sul: nenhum prédio em cima dela
      if (eixo === 0 && cz > 0 && cx + s < CORREDOR_FERROVIA.xMax + 2 && cx + s + larg > CORREDOR_FERROVIA.xMin - 2) {
        s += larg + 2;
        continue;
      }
      p.position.set(eixo === 0 ? cx + meio : cx + (rnd() - 0.5) * 6, ALTURA_CALCADA, eixo === 0 ? cz + (rnd() - 0.5) * 6 : cz + meio);
      // fachada voltada para a pista
      p.rotation.y = eixo === 0 ? (cz < 0 ? 0 : Math.PI) : cx < 0 ? Math.PI / 2 : -Math.PI / 2;
      predios.add(p);
      s += larg + 2 + rnd() * 6;
    }
  }
  raiz.add(predios);
}
