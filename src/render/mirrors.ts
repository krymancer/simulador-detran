import * as THREE from 'three';

/**
 * Retrovisores (central e laterais) para a câmera de cockpit: cada um renderiza
 * a cena num render target e é desenhado espelhado num overlay ortográfico.
 */
export class Retrovisores {
  private readonly itens: { cam: THREE.PerspectiveCamera; rt: THREE.WebGLRenderTarget; quad: THREE.Mesh; origem: THREE.Object3D }[] = [];
  private readonly cenaOverlay = new THREE.Scene();
  private readonly camOverlay = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);

  constructor(origens: { centro: THREE.Object3D; esq: THREE.Object3D; dir: THREE.Object3D }) {
    const mk = (origem: THREE.Object3D, w: number, h: number, fov: number) => {
      const rt = new THREE.WebGLRenderTarget(w, h);
      rt.texture.colorSpace = THREE.SRGBColorSpace;
      const cam = new THREE.PerspectiveCamera(fov, w / h, 0.05, 250);
      const tex = rt.texture;
      tex.wrapS = THREE.RepeatWrapping;
      tex.repeat.x = -1; // espelhado
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex }));
      const borda = new THREE.Mesh(new THREE.PlaneGeometry(1.06, 1.12), new THREE.MeshBasicMaterial({ color: 0x111111 }));
      borda.position.z = -0.1;
      quad.add(borda);
      this.cenaOverlay.add(quad);
      this.itens.push({ cam, rt, quad, origem });
    };
    mk(origens.centro, 512, 140, 18);
    mk(origens.esq, 256, 170, 30);
    mk(origens.dir, 256, 170, 30);
  }

  private layout(w: number, h: number): void {
    const s = Math.min(1, w / 1400);
    const [c, e, d] = this.itens;
    c.quad.scale.set(420 * s, 115 * s, 1);
    c.quad.position.set(w / 2, h - 75 * s, 0);
    e.quad.scale.set(220 * s, 145 * s, 1);
    e.quad.position.set(140 * s, h * 0.42, 0);
    d.quad.scale.set(220 * s, 145 * s, 1);
    d.quad.position.set(w - 140 * s, h * 0.42, 0);
    this.camOverlay.right = w;
    this.camOverlay.top = h;
    this.camOverlay.updateProjectionMatrix();
  }

  render(renderer: THREE.WebGLRenderer, cena: THREE.Scene, w: number, h: number): void {
    for (const it of this.itens) {
      it.origem.getWorldPosition(it.cam.position);
      it.origem.getWorldQuaternion(it.cam.quaternion);
      // a câmera olha para −Z; o objeto de origem aponta +Z para trás → gira 180°
      it.cam.rotateY(Math.PI);
      renderer.setRenderTarget(it.rt);
      renderer.render(cena, it.cam);
    }
    renderer.setRenderTarget(null);
    this.layout(w, h);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.cenaOverlay, this.camOverlay);
    renderer.autoClear = true;
  }
}
