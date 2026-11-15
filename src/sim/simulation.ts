import RAPIER from '@dimforge/rapier3d-compat';
import { CarConfig } from './carConfig';
import { Comandos } from './powertrain';
import { Veiculo } from './vehicle';
import { Mapa, TipoColisor } from '../world/parser';

export const HZ_FISICA = 200;
export const DT_FISICA = 1 / HZ_FISICA;

let rapierPronto: Promise<void> | null = null;
export function iniciarRapier(): Promise<void> {
  if (!rapierPronto) rapierPronto = RAPIER.init();
  return rapierPronto;
}

/** Mundo físico: colisores do mapa + carro. Não depende de renderização. */
export class Simulacao {
  readonly mundo: RAPIER.World;
  readonly carro: Veiculo;
  readonly mapa: Mapa;
  /** handle do colisor → tipo (para saber se a roda está na calçada). */
  readonly tipoColisor = new Map<number, TipoColisor>();
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

    this.carro = new Veiculo(this.mundo, cfg);
    this.reposicionar();
  }

  reposicionar(): void {
    this.carro.posicionar(this.mapa.spawn.posicao, this.mapa.spawn.yaw);
  }

  passo(cmd: Comandos): void {
    this.carro.passo(DT_FISICA, cmd);
    this.mundo.step();
    this.tempo += DT_FISICA;
  }

  liberar(): void {
    this.mundo.free();
  }
}
