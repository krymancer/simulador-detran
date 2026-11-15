import * as THREE from 'three';
import { Veiculo } from '../sim/vehicle';

const flat = (cor: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color: cor, roughness: 0.6, flatShading: true, ...extra });

/** Carro low-poly + interior simples (painel, volante) para a câmera de cockpit. */
export class VisualCarro {
  readonly grupo = new THREE.Group();
  readonly rodas: THREE.Group[] = [];
  readonly volante = new THREE.Group();
  readonly olho = new THREE.Object3D();
  readonly retrovisores: { centro: THREE.Object3D; esq: THREE.Object3D; dir: THREE.Object3D };
  private readonly luzesFreio: THREE.MeshStandardMaterial;
  private readonly setaEsq: THREE.MeshStandardMaterial;
  private readonly setaDir: THREE.MeshStandardMaterial;
  private readonly carroceria: THREE.Group;

  constructor(v: Veiculo) {
    const cfg = v.cfg;
    const cb = cfg.carroceria;
    const yChao = -cfg.alturaCG;
    const largura = cb.meiaLargura * 2;
    const comp = cb.meiaComprimento * 2;
    const zC = cb.centro[2];

    const pintura = flat(0xd9502b, { roughness: 0.45 });
    const vidro = flat(0x1d2a38, { roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.55 });
    const preto = flat(0x1b1b1b);
    const plastico = flat(0x2c2c2c);

    this.carroceria = new THREE.Group();
    this.grupo.add(this.carroceria);

    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, sombra = true) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = sombra;
      mesh.receiveShadow = sombra;
      this.carroceria.add(mesh);
      return mesh;
    };

    // Parte baixa
    const hBaixo = 0.55;
    add(new THREE.BoxGeometry(largura, hBaixo, comp), pintura, 0, yChao + 0.22 + hBaixo / 2, zC);
    // Capô levemente inclinado
    const capo = add(new THREE.BoxGeometry(largura * 0.96, 0.12, 1.0), pintura, 0, yChao + 0.22 + hBaixo + 0.02, zC + comp / 2 - 0.55);
    capo.rotation.x = 0.08;
    // Cabine
    const hCab = 0.62;
    const cab = add(new THREE.BoxGeometry(largura * 0.9, hCab, 2.05), vidro, 0, yChao + 0.22 + hBaixo + hCab / 2, zC - 0.25, false);
    cab.castShadow = true;
    // Teto + colunas
    add(new THREE.BoxGeometry(largura * 0.9, 0.06, 1.75), pintura, 0, yChao + 0.22 + hBaixo + hCab, zC - 0.35);
    for (const x of [-1, 1]) {
      const colA = add(new THREE.BoxGeometry(0.06, hCab * 1.05, 0.08), pintura, x * largura * 0.44, yChao + 0.22 + hBaixo + hCab / 2, zC + 0.68);
      colA.rotation.x = -0.45;
      add(new THREE.BoxGeometry(0.06, hCab, 0.12), pintura, x * largura * 0.44, yChao + 0.22 + hBaixo + hCab / 2, zC - 1.2);
    }
    // Para-choques
    add(new THREE.BoxGeometry(largura * 1.01, 0.22, 0.12), plastico, 0, yChao + 0.35, zC + comp / 2 + 0.02);
    add(new THREE.BoxGeometry(largura * 1.01, 0.22, 0.12), plastico, 0, yChao + 0.35, zC - comp / 2 - 0.02);
    // Faróis e lanternas
    const farol = flat(0xfff6d5, { emissive: 0x333322 });
    for (const x of [-1, 1]) add(new THREE.BoxGeometry(0.3, 0.12, 0.04), farol, x * 0.55, yChao + 0.62, zC + comp / 2 + 0.01, false);
    this.luzesFreio = flat(0x550000, { emissive: 0x000000 });
    for (const x of [-1, 1]) add(new THREE.BoxGeometry(0.22, 0.16, 0.04), this.luzesFreio, x * 0.6, yChao + 0.62, zC - comp / 2 - 0.01, false);
    // Setas (frente e trás). +X é a esquerda do carro.
    this.setaEsq = flat(0x553300, { emissive: 0x000000 });
    this.setaDir = flat(0x553300, { emissive: 0x000000 });
    for (const [x, m] of [[1, this.setaEsq], [-1, this.setaDir]] as const) {
      add(new THREE.BoxGeometry(0.1, 0.08, 0.04), m, x * 0.74, yChao + 0.55, zC + comp / 2 + 0.01, false);
      add(new THREE.BoxGeometry(0.1, 0.08, 0.04), m, x * 0.74, yChao + 0.5, zC - comp / 2 - 0.01, false);
    }

    // Retrovisores externos (só visual) + pontos de onde as câmeras dos espelhos olham
    const yEsp = yChao + 0.22 + hBaixo + 0.18;
    const zEsp = zC + 0.95;
    for (const x of [-1, 1]) add(new THREE.BoxGeometry(0.16, 0.1, 0.06), preto, x * (largura / 2 + 0.08), yEsp, zEsp);
    const ptEsp = (x: number, y: number, z: number, yaw: number) => {
      const o = new THREE.Object3D();
      o.position.set(x, y, z);
      o.rotation.y = Math.PI + yaw; // olhando para trás
      this.grupo.add(o);
      return o;
    };
    this.retrovisores = {
      centro: ptEsp(0, yChao + 1.2, zC + 0.55, 0),
      esq: ptEsp(largura / 2 + 0.1, yEsp, zEsp, -0.12),
      dir: ptEsp(-largura / 2 - 0.1, yEsp, zEsp, 0.12),
    };

    // Interior: painel e volante. Motorista à esquerda (+X).
    const xMot = 0.36;
    add(new THREE.BoxGeometry(largura * 0.86, 0.22, 0.3), plastico, 0, yChao + 0.95, zC + 0.62, false);
    this.volante.position.set(xMot, yChao + 1.0, zC + 0.38);
    this.volante.rotation.x = -0.35;
    const aro = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.018, 6, 18), preto);
    const raio1 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 0.02), preto);
    const raio2 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.17, 0.02), preto);
    raio2.position.y = -0.08;
    const marca = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.025), flat(0xdddddd));
    marca.position.y = 0.18; // marca no topo para ver o quanto girou
    this.volante.add(aro, raio1, raio2, marca);
    this.carroceria.add(this.volante);

    this.olho.position.set(xMot, yChao + 1.18, zC + 0.0);
    this.grupo.add(this.olho);

    // Rodas
    const r = cfg.roda.raio;
    const pneu = flat(0x161616);
    const aroRoda = flat(0x9a9a9a, { metalness: 0.4 });
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const spin = new THREE.Group();
      const p = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.165, 14), pneu);
      p.rotation.z = Math.PI / 2;
      p.castShadow = true;
      const a = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.17, 6), aroRoda);
      a.rotation.z = Math.PI / 2;
      spin.add(p, a);
      g.add(spin);
      this.grupo.add(g);
      this.rodas.push(g);
    }
  }

  atualizar(v: Veiculo, freando: boolean, setaLigada: 'esquerda' | 'direita' | null, piscando: boolean, cockpit: boolean): void {
    const t = v.corpo.translation();
    const q = v.corpo.rotation();
    this.grupo.position.set(t.x, t.y, t.z);
    this.grupo.quaternion.set(q.x, q.y, q.z, q.w);

    for (let i = 0; i < 4; i++) {
      const rd = v.rodas[i];
      const g = this.rodas[i];
      g.position.set(rd.montagem.x, rd.montagem.y - rd.comprimento, rd.montagem.z);
      g.rotation.set(0, rd.anguloEsterco, 0);
      g.children[0].rotation.x = rd.rotacao;
    }
    // Rotação positiva em +Z (para a frente) é horária vista pelo motorista = virar à direita.
    this.volante.rotation.set(-0.35, 0, 0);
    this.volante.rotateZ(v.anguloVolante);

    this.luzesFreio.emissive.setHex(freando ? 0xff1a1a : 0x000000);
    this.setaEsq.emissive.setHex(setaLigada === 'esquerda' && piscando ? 0xffa000 : 0x000000);
    this.setaDir.emissive.setHex(setaLigada === 'direita' && piscando ? 0xffa000 : 0x000000);

    // No cockpit, esconde a cabine de vidro (atrapalha a visão) mas mantém colunas e painel.
    const cab = this.carroceria.children[2];
    cab.visible = !cockpit;
  }
}
