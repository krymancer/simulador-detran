import * as THREE from 'three';

type Lado = 'centro' | 'esq' | 'dir';

/**
 * Retrovisores de verdade: cada espelho do carro (central e laterais) recebe a
 * imagem de uma câmera virada para trás, renderizada numa textura espelhada.
 * Assim os espelhos aparecem dentro da cena, no lugar certo, como num simulador.
 */
export class Retrovisores {
  private readonly itens: { cam: THREE.PerspectiveCamera; rt: THREE.WebGLRenderTarget; origem: THREE.Object3D }[] = [];
  private quadro = 0;
  /** Laterais renderizados a cada N quadros (qualidade). */
  intervaloLaterais = 2;
  private readonly superficies: THREE.Mesh[];

  constructor(
    origens: Record<Lado, THREE.Object3D>,
    superficies: Record<Lado, THREE.Mesh>,
  ) {
    this.superficies = Object.values(superficies);
    const mk = (lado: Lado, w: number, h: number, fov: number) => {
      const rt = new THREE.WebGLRenderTarget(w, h, { samples: 2 });
      rt.texture.colorSpace = THREE.SRGBColorSpace;
      rt.texture.wrapS = THREE.RepeatWrapping;
      rt.texture.repeat.x = -1; // espelhado
      const cam = new THREE.PerspectiveCamera(fov, w / h, 0.1, 300);
      const mat = superficies[lado].material as THREE.MeshBasicMaterial;
      mat.map = rt.texture;
      mat.color?.setHex(0xffffff);
      mat.needsUpdate = true;
      this.itens.push({ cam, rt, origem: origens[lado] });
    };
    mk('centro', 512, 160, 22);
    mk('esq', 256, 192, 32);
    mk('dir', 256, 192, 32);
  }

  /** Renderiza os espelhos (o carro deve estar visível para aparecer nos laterais). */
  render(renderer: THREE.WebGLRenderer, cena: THREE.Scene): void {
    this.quadro++;
    // Esconde as superfícies para não ler e escrever a mesma textura.
    for (const m of this.superficies) m.visible = false;
    for (let i = 0; i < this.itens.length; i++) {
      const it = this.itens[i];
      // Laterais a cada N quadros para economizar (alternando esquerdo/direito).
      if (i > 0 && (this.quadro + i) % this.intervaloLaterais !== 0) continue;
      it.origem.updateWorldMatrix(true, false);
      it.origem.getWorldPosition(it.cam.position);
      it.origem.getWorldQuaternion(it.cam.quaternion);
      // A câmera olha para −Z; a origem aponta +Z para trás → gira 180°.
      it.cam.rotateY(Math.PI);
      renderer.setRenderTarget(it.rt);
      renderer.render(cena, it.cam);
    }
    renderer.setRenderTarget(null);
    for (const m of this.superficies) m.visible = true;
  }
}
