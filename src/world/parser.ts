import * as THREE from 'three';

/**
 * Convenções de nome (objetos do Blender → glTF/GLB):
 *
 *   COL_<nome>            Colisor (malha estática). Fica invisível, a menos que tenha a
 *                         propriedade customizada `visivel = true`.
 *                         Se o nome contiver "calcada" ou "meiofio", é calçada (gera falta).
 *   BALIZA_<n>            Haste da baliza. Tocar = falta.
 *   CONE_<n>              Cone. Tocar = falta.
 *   ZONA_BALIZA[_n]       Vaga da baliza (caixa). O carro tem que terminar inteiro dentro.
 *   ZONA_RAMPA[_n]        Trecho da rampa: parar e recuar aqui = falta.
 *   FAIXA_PEDESTRE_<n>    Faixa de pedestre: parar em cima = falta.
 *   SEMAFORO_<id>         Poste do semáforo (a lâmpada é criada pelo jogo em cima dele).
 *   LINHA_PARADA_<id>     Linha de retenção do SEMAFORO_<id>. Cruzar no vermelho = eliminatória.
 *   SPAWN_CARRO           Onde o carro nasce. O carro aponta para o eixo +Y do Blender
 *                         (−Z no three.js).
 *
 * Zonas e linhas são caixas (o jogo usa o bounding box do objeto, com rotação/escala),
 * e ficam invisíveis. Maiúsculas/minúsculas não importam. O sufixo ".001" que o
 * Blender cria é ignorado.
 */

export type TipoColisor = 'chao' | 'calcada';

export interface Colisor {
  nome: string;
  tipo: TipoColisor;
  vertices: Float32Array;
  indices: Uint32Array;
}

export interface Obstaculo {
  nome: string;
  tipo: 'baliza' | 'cone';
  x: number;
  z: number;
  raio: number;
  objeto: THREE.Object3D;
}

export interface Zona {
  nome: string;
  tipo: 'baliza' | 'rampa' | 'faixa_pedestre' | 'linha_parada';
  id: string;
  /** Matriz mundo→local do objeto; a caixa é [min, max] no espaço local. */
  inversa: THREE.Matrix4;
  min: THREE.Vector3;
  max: THREE.Vector3;
  centro: THREE.Vector3;
}

export interface Semaforo {
  id: string;
  objeto: THREE.Object3D;
  topo: THREE.Vector3;
  tempos: { verde: number; amarelo: number; vermelho: number };
  defasagem: number;
}

export interface Mapa {
  raiz: THREE.Object3D;
  colisores: Colisor[];
  obstaculos: Obstaculo[];
  zonas: Zona[];
  semaforos: Semaforo[];
  spawn: { posicao: THREE.Vector3; yaw: number };
}

function normalizar(nome: string): string {
  return nome.toUpperCase().replace(/[.\s-]/g, '_');
}

function malhasDe(obj: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

/** Junta todas as malhas de um objeto em um único buffer de triângulos em coordenadas de mundo. */
function trianglesMundo(obj: THREE.Object3D): { vertices: Float32Array; indices: Uint32Array } {
  const verts: number[] = [];
  const idx: number[] = [];
  const v = new THREE.Vector3();
  for (const mesh of malhasDe(obj)) {
    const g = mesh.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position');
    if (!pos) continue;
    const base = verts.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      verts.push(v.x, v.y, v.z);
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) idx.push(base + i);
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx) };
}

function caixaLocal(obj: THREE.Object3D): THREE.Box3 {
  // Bounding box no espaço local do objeto (inclui filhos).
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const mesh of malhasDe(obj)) {
    const pos = (mesh.geometry as THREE.BufferGeometry).getAttribute('position');
    if (!pos) continue;
    const m = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m));
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  return box;
}

export function lerMapa(raiz: THREE.Object3D): Mapa {
  raiz.updateMatrixWorld(true);

  const mapa: Mapa = {
    raiz,
    colisores: [],
    obstaculos: [],
    zonas: [],
    semaforos: [],
    spawn: { posicao: new THREE.Vector3(0, 1, 0), yaw: 0 },
  };

  // Coleta primeiro para não alterar a árvore durante o traverse.
  const nos: THREE.Object3D[] = [];
  raiz.traverse((o) => nos.push(o));

  for (const o of nos) {
    const n = normalizar(o.name || '');
    if (!n) continue;
    const ud = o.userData ?? {};

    if (n.startsWith('COL_')) {
      const { vertices, indices } = trianglesMundo(o);
      if (indices.length >= 3) {
        const tipo: TipoColisor = /CALCADA|MEIOFIO|MEIO_FIO/.test(n) || ud.tipo === 'calcada' ? 'calcada' : 'chao';
        mapa.colisores.push({ nome: o.name, tipo, vertices, indices });
      }
      if (!ud.visivel) o.visible = false;
    } else if (n.startsWith('BALIZA_') || n.startsWith('CONE_')) {
      const box = new THREE.Box3().setFromObject(o);
      const c = box.getCenter(new THREE.Vector3());
      const s = box.getSize(new THREE.Vector3());
      mapa.obstaculos.push({
        nome: o.name,
        tipo: n.startsWith('CONE_') ? 'cone' : 'baliza',
        x: c.x,
        z: c.z,
        raio: Math.max(0.03, 0.5 * Math.max(s.x, s.z)),
        objeto: o,
      });
    } else if (n.startsWith('ZONA_') || n.startsWith('FAIXA_PEDESTRE') || n.startsWith('LINHA_PARADA')) {
      let tipo: Zona['tipo'];
      let id = '';
      if (n.startsWith('ZONA_BALIZA')) tipo = 'baliza';
      else if (n.startsWith('ZONA_RAMPA')) tipo = 'rampa';
      else if (n.startsWith('FAIXA_PEDESTRE')) tipo = 'faixa_pedestre';
      else {
        tipo = 'linha_parada';
        id = n.slice('LINHA_PARADA_'.length);
      }
      if (!n.startsWith('ZONA_BALIZA') && !n.startsWith('ZONA_RAMPA') && n.startsWith('ZONA_')) continue;
      const box = caixaLocal(o);
      mapa.zonas.push({
        nome: o.name,
        tipo,
        id,
        inversa: new THREE.Matrix4().copy(o.matrixWorld).invert(),
        min: box.min.clone(),
        max: box.max.clone(),
        centro: box.getCenter(new THREE.Vector3()).applyMatrix4(o.matrixWorld),
      });
      o.visible = !!ud.visivel;
    } else if (n.startsWith('SEMAFORO_')) {
      const box = new THREE.Box3().setFromObject(o);
      const topo = box.getCenter(new THREE.Vector3());
      topo.y = box.max.y;
      mapa.semaforos.push({
        id: n.slice('SEMAFORO_'.length),
        objeto: o,
        topo,
        tempos: {
          verde: Number(ud.verde ?? 12),
          amarelo: Number(ud.amarelo ?? 3),
          vermelho: Number(ud.vermelho ?? 10),
        },
        defasagem: Number(ud.defasagem ?? 0),
      });
    } else if (n.startsWith('SPAWN_CARRO')) {
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      o.matrixWorld.decompose(p, q, new THREE.Vector3());
      const frente = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      mapa.spawn = { posicao: p, yaw: Math.atan2(frente.x, frente.z) };
    }
  }

  return mapa;
}

/** Ponto (mundo) dentro da caixa da zona? */
export function dentroDaZona(z: Zona, p: THREE.Vector3, tmp = new THREE.Vector3()): boolean {
  tmp.copy(p).applyMatrix4(z.inversa);
  return (
    tmp.x >= z.min.x && tmp.x <= z.max.x &&
    tmp.y >= z.min.y - 1.5 && tmp.y <= z.max.y + 1.5 && // tolerância vertical
    tmp.z >= z.min.z && tmp.z <= z.max.z
  );
}
