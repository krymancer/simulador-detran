import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CarConfig } from './carConfig';
import { Comandos } from './powertrain';
import { Veiculo } from './vehicle';
import { Mapa, Obstaculo, TipoColisor } from '../world/parser';

export const HZ_FISICA = 200;
export const DT_FISICA = 1 / HZ_FISICA;

let rapierPronto: Promise<void> | null = null;
export function iniciarRapier(): Promise<void> {
  if (!rapierPronto) rapierPronto = RAPIER.init();
  return rapierPronto;
}

interface ObstaculoFisico {
  o: Obstaculo;
  corpo: RAPIER.RigidBody;
  /** Deslocamento (no referencial do corpo) do centro do corpo até a origem do objeto visual. */
  offset: THREE.Vector3;
  q0: THREE.Quaternion;
  inicio: { p: THREE.Vector3; q: THREE.Quaternion };
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _pai = new THREE.Matrix4();

/** Mundo físico: colisores do mapa + carro + cones/balizas soltos. Não depende de renderização. */
export class Simulacao {
  readonly mundo: RAPIER.World;
  readonly carro: Veiculo;
  readonly mapa: Mapa;
  /** handle do colisor do chão → tipo (para saber se a roda está na calçada). */
  readonly tipoColisor = new Map<number, TipoColisor>();
  private readonly obstaculos: ObstaculoFisico[] = [];
  tempo = 0;

  constructor(mapa: Mapa, cfg: CarConfig) {
    this.mapa = mapa;
    this.mundo = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.mundo.timestep = DT_FISICA;

    for (const c of mapa.colisores) {
      const desc = RAPIER.ColliderDesc.trimesh(c.vertices, c.indices).setFriction(0.9);
      const col = this.mundo.createCollider(desc);
      this.tipoColisor.set(col.handle, c.tipo);
    }

    // Sólidos (postes, troncos, prédios): só a carroceria bate neles.
    for (const s of mapa.solidos) {
      if (s.tipo === 'cilindro') {
        this.mundo.createCollider(
          RAPIER.ColliderDesc.cylinder(s.altura / 2, s.raio).setTranslation(s.x, s.y + s.altura / 2, s.z).setFriction(0.5),
        );
      } else {
        this.mundo.createCollider(
          RAPIER.ColliderDesc.cuboid(s.meia.x, s.meia.y, s.meia.z)
            .setTranslation(s.centro.x, s.centro.y, s.centro.z)
            .setRotation({ x: s.rotacao.x, y: s.rotacao.y, z: s.rotacao.z, w: s.rotacao.w })
            .setFriction(0.5),
        );
      }
    }

    // Cones e balizas: corpos dinâmicos leves (caem quando o carro bate).
    for (const o of mapa.obstaculos) {
      o.objeto.updateMatrixWorld(true);
      const p = new THREE.Vector3(o.x, o.y, o.z);
      const corpo = this.mundo.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setLinearDamping(0.3).setAngularDamping(0.6),
      );
      const forma =
        o.tipo === 'cone'
          ? RAPIER.ColliderDesc.cone(o.altura / 2, o.raio)
          : RAPIER.ColliderDesc.cylinder(o.altura / 2, Math.max(o.raio, 0.04));
      this.mundo.createCollider(forma.setMass(o.tipo === 'cone' ? 1.2 : 2.5).setFriction(0.8).setRestitution(0.1), corpo);
      const wp = new THREE.Vector3();
      const wq = new THREE.Quaternion();
      o.objeto.matrixWorld.decompose(wp, wq, new THREE.Vector3());
      this.obstaculos.push({ o, corpo, offset: wp.sub(p), q0: wq, inicio: { p: p.clone(), q: new THREE.Quaternion() } });
    }

    const tipos = this.tipoColisor;
    this.carro = new Veiculo(this.mundo, cfg, (c) => tipos.has(c.handle));
    this.reposicionar();
  }

  reposicionar(): void {
    this.carro.posicionar(this.mapa.spawn.posicao, this.mapa.spawn.yaw);
  }

  /** Recoloca cones e balizas de pé. */
  reporObstaculos(): void {
    for (const ob of this.obstaculos) {
      ob.corpo.setTranslation({ x: ob.inicio.p.x, y: ob.inicio.p.y, z: ob.inicio.p.z }, true);
      ob.corpo.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      ob.corpo.setLinvel({ x: 0, y: 0, z: 0 }, true);
      ob.corpo.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    this.sincronizarObstaculos();
  }

  /** O obstáculo está tombado/fora do lugar? */
  derrubado(o: Obstaculo): boolean {
    const ob = this.obstaculos.find((x) => x.o === o);
    if (!ob) return false;
    const r = ob.corpo.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    return new THREE.Vector3(0, 1, 0).applyQuaternion(_q).y < 0.8;
  }

  private sincronizarObstaculos(): void {
    for (const ob of this.obstaculos) {
      const t = ob.corpo.translation();
      const r = ob.corpo.rotation();
      ob.o.x = t.x;
      ob.o.y = t.y;
      ob.o.z = t.z;
      // Objeto visual acompanha o corpo (convertendo para o espaço do pai).
      _q.set(r.x, r.y, r.z, r.w);
      _p.copy(ob.offset).applyQuaternion(_q).add(new THREE.Vector3(t.x, t.y, t.z));
      const qMundo = _q.clone().multiply(ob.q0);
      _m.compose(_p, qMundo, ob.o.objeto.getWorldScale(new THREE.Vector3()));
      const pai = ob.o.objeto.parent;
      if (pai) {
        pai.updateMatrixWorld();
        _m.premultiply(_pai.copy(pai.matrixWorld).invert());
      }
      _m.decompose(ob.o.objeto.position, ob.o.objeto.quaternion, ob.o.objeto.scale);
    }
  }

  passo(cmd: Comandos): void {
    this.carro.passo(DT_FISICA, cmd);
    this.mundo.step();
    this.sincronizarObstaculos();
    this.tempo += DT_FISICA;
  }

  liberar(): void {
    this.mundo.free();
  }
}
