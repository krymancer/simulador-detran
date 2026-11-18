import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CarConfig } from './carConfig';
import { Comandos, EntradaRoda, TremDeForca } from './powertrain';

export interface EstadoRoda {
  /** Posição de montagem no referencial do carro. */
  montagem: THREE.Vector3;
  dianteira: boolean;
  esquerda: boolean;
  noChao: boolean;
  comprimento: number;      // montagem → centro da roda
  compressaoAnterior: number;
  fz: number;
  fy: number;
  vx: number;
  vy: number;
  anguloEsterco: number;    // rad, positivo = esquerda
  rotacao: number;          // ângulo acumulado (visual)
  colisorChao: number | null; // handle do colisor tocado
  pontoContato: THREE.Vector3;
  cerdaLat: number;
  /** Força lateral do pneu já com a relaxação (não aparece instantânea). */
  fyRelax: number;
  compressao: number;
  /** Atrito máximo disponível (N), já com a sensibilidade à carga. */
  D: number;
  /** Fração da aderência em uso (0 = folgado, 1 = no limite / deslizando). */
  uso: number;
}

const suave = (a: number, b: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _cima = new THREE.Vector3();
const _frente = new THREE.Vector3();

/**
 * Carro com suspensão por raycast sobre um corpo rígido Rapier. Pneus e trem de
 * força são calculados por nós; o Rapier só integra o chassi e resolve colisões.
 */
export class Veiculo {
  readonly cfg: CarConfig;
  readonly corpo: RAPIER.RigidBody;
  readonly colisor: RAPIER.Collider;
  readonly trem: TremDeForca;
  readonly rodas: EstadoRoda[];
  private readonly mundo: RAPIER.World;

  /** Ângulo do volante do carro (rad), positivo = direita. */
  anguloVolante = 0;
  /** Torque autoalinhante somado das rodas dianteiras (N·m) — base do force feedback. */
  torqueAutoalinhante = 0;

  /** Quais colisores a roda pode “pisar” (o chão do mapa; não cones nem postes). */
  private readonly chao: ((c: RAPIER.Collider) => boolean) | undefined;

  constructor(mundo: RAPIER.World, cfg: CarConfig, chao?: (c: RAPIER.Collider) => boolean) {
    this.mundo = mundo;
    this.chao = chao;
    this.cfg = cfg;
    this.trem = new TremDeForca(cfg);

    const desc = RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setCcdEnabled(true);
    this.corpo = mundo.createRigidBody(desc);

    const cb = cfg.carroceria;
    const cdesc = RAPIER.ColliderDesc.cuboid(cb.meiaLargura, cb.meiaAltura, cb.meiaComprimento)
      .setTranslation(cb.centro[0], cb.centro[1], cb.centro[2])
      .setFriction(0.4)
      .setRestitution(0.05)
      .setMassProperties(
        cfg.massa,
        // Centro de massa é relativo ao colisor (que está deslocado): volta para a origem do corpo.
        { x: -cb.centro[0], y: -cb.centro[1], z: -cb.centro[2] },
        { x: cfg.inercia[0], y: cfg.inercia[1], z: cfg.inercia[2] },
        { x: 0, y: 0, z: 0, w: 1 },
      );
    this.colisor = mundo.createCollider(cdesc, this.corpo);

    // Montagens: altura tal que, parado, a roda fique encostada no chão.
    const r = cfg.roda.raio;
    const yRoda = r - cfg.alturaCG;
    const s = cfg.suspensao;
    const pesoF = (cfg.massa * 9.81 * -cfg.eixoTraseiroZ) / (cfg.eixoDianteiroZ - cfg.eixoTraseiroZ) / 2;
    const pesoT = (cfg.massa * 9.81 * cfg.eixoDianteiroZ) / (cfg.eixoDianteiroZ - cfg.eixoTraseiroZ) / 2;
    const compF = s.cursoMax - pesoF / s.molaDianteira;
    const compT = s.cursoMax - pesoT / s.molaTraseira;

    const mk = (dianteira: boolean, esquerda: boolean): EstadoRoda => {
      const x = (esquerda ? 0.5 : -0.5) * (dianteira ? cfg.bitolaDianteira : cfg.bitolaTraseira);
      const z = dianteira ? cfg.eixoDianteiroZ : cfg.eixoTraseiroZ;
      const y = yRoda + (dianteira ? compF : compT);
      return {
        montagem: new THREE.Vector3(x, y, z),
        dianteira,
        esquerda,
        noChao: false,
        comprimento: s.cursoMax,
        compressaoAnterior: 0,
        fz: 0, fy: 0, vx: 0, vy: 0,
        anguloEsterco: 0,
        rotacao: 0,
        colisorChao: null,
        pontoContato: new THREE.Vector3(),
        cerdaLat: 0,
        fyRelax: 0,
        compressao: 0,
        D: 0,
        uso: 0,
      };
    };
    this.rodas = [mk(true, true), mk(true, false), mk(false, true), mk(false, false)];
  }

  posicionar(pos: THREE.Vector3, yaw: number): void {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.corpo.setTranslation({ x: pos.x, y: pos.y + this.cfg.alturaCG + 0.02, z: pos.z }, true);
    this.corpo.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.corpo.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.corpo.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.trem.reiniciar();
    for (const rd of this.rodas) {
      rd.cerdaLat = 0;
      rd.fyRelax = 0;
      rd.compressaoAnterior = 0;
    }
  }

  /** Velocidade do carro na direção da frente (m/s). */
  velocidadeLongitudinal(): number {
    const lv = this.corpo.linvel();
    const r = this.corpo.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _frente.set(0, 0, 1).applyQuaternion(_q);
    return lv.x * _frente.x + lv.y * _frente.y + lv.z * _frente.z;
  }

  velocidade(): number {
    const lv = this.corpo.linvel();
    return Math.hypot(lv.x, lv.y, lv.z);
  }

  passo(dt: number, cmd: Comandos, subpassos = 5): void {
    const cfg = this.cfg;
    const corpo = this.corpo;
    const s = cfg.suspensao;
    const p = cfg.pneu;
    const r = cfg.roda.raio;

    const t = corpo.translation();
    const rot = corpo.rotation();
    _q.set(rot.x, rot.y, rot.z, rot.w);
    _cima.set(0, 1, 0).applyQuaternion(_q);
    const origem = new THREE.Vector3(t.x, t.y, t.z);

    // Direção: volante do carro ±(voltas/2)·360°, Ackermann nas rodas.
    const meioCurso = cfg.direcao.voltasBatenteABatente * Math.PI;
    this.anguloVolante = cmd.volante * meioCurso;
    const delta = (-cmd.volante) * cfg.direcao.anguloMaxRoda; // positivo = esquerda
    const L = cfg.eixoDianteiroZ - cfg.eixoTraseiroZ;
    let dEsq = delta;
    let dDir = delta;
    if (Math.abs(delta) > 1e-4) {
      const R = L / Math.tan(Math.abs(delta));
      const meia = cfg.bitolaDianteira / 2;
      const interna = Math.atan(L / (R - meia));
      const externa = Math.atan(L / (R + meia));
      const sinal = Math.sign(delta);
      if (delta > 0) { dEsq = sinal * interna; dDir = sinal * externa; }
      else { dEsq = sinal * externa; dDir = sinal * interna; }
    }
    this.rodas[0].anguloEsterco = dEsq;
    this.rodas[1].anguloEsterco = dDir;

    const entradas: EntradaRoda[] = [];
    const frentes: THREE.Vector3[] = [];
    const lados: THREE.Vector3[] = [];

    // 1) Suspensão + força lateral
    for (const rd of this.rodas) {
      const montagemMundo = rd.montagem.clone().applyQuaternion(_q).add(origem);
      const ray = new RAPIER.Ray(
        { x: montagemMundo.x, y: montagemMundo.y, z: montagemMundo.z },
        { x: -_cima.x, y: -_cima.y, z: -_cima.z },
      );
      const alcance = s.cursoMax + r;
      const hit = this.mundo.castRayAndGetNormal(ray, alcance, true, undefined, undefined, undefined, corpo, this.chao);

      const fwd = new THREE.Vector3();
      const side = new THREE.Vector3();
      if (!hit) {
        rd.noChao = false;
        rd.compressao = 0;
        rd.fyRelax = 0;
        rd.comprimento = s.cursoMax;
        rd.compressaoAnterior = 0;
        rd.fz = 0;
        rd.fy = 0;
        rd.D = 0;
        rd.uso = 0;
        rd.colisorChao = null;
        rd.cerdaLat *= 0.9;
        entradas.push({ noChao: false, vx: 0, fxMax: 0, fz: 0 });
        frentes.push(fwd);
        lados.push(side);
        continue;
      }

      const toi = hit.timeOfImpact;
      const n = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
      rd.noChao = true;
      rd.colisorChao = hit.collider.handle;
      rd.comprimento = Math.max(0, toi - r);
      rd.pontoContato.copy(montagemMundo).addScaledVector(_cima, -toi);

      const compressao = s.cursoMax - rd.comprimento;
      const velComp = (compressao - rd.compressaoAnterior) / dt;
      rd.compressaoAnterior = compressao;
      const k = rd.dianteira ? s.molaDianteira : s.molaTraseira;
      const c = rd.dianteira ? s.amortecedorDianteiro : s.amortecedorTraseiro;
      rd.compressao = compressao;
      // Barra estabilizadora (usa a compressão da roda oposta no passo anterior: 5 ms de atraso, irrelevante).
      const oposta = this.rodas[this.rodas.indexOf(rd) ^ 1];
      const kBarra = rd.dianteira ? s.barraDianteira : s.barraTraseira;
      const difBarra = oposta.noChao ? compressao - oposta.compressao : compressao - Math.max(0, s.cursoMax - oposta.comprimento);
      let fz = k * compressao + c * velComp + kBarra * difBarra;
      if (rd.comprimento < s.batenteCurso) fz += s.batenteRigidez * (s.batenteCurso - rd.comprimento);
      fz = Math.max(0, fz);
      rd.fz = fz;

      // Base da roda no plano do chão
      _frente.set(Math.sin(rd.anguloEsterco), 0, Math.cos(rd.anguloEsterco)).applyQuaternion(_q);
      fwd.copy(_frente).addScaledVector(n, -_frente.dot(n)).normalize();
      side.crossVectors(n, fwd).normalize(); // aponta para a esquerda

      const vp = corpo.velocityAtPoint({ x: rd.pontoContato.x, y: rd.pontoContato.y, z: rd.pontoContato.z });
      _v.set(vp.x, vp.y, vp.z);
      rd.vx = _v.dot(fwd);
      rd.vy = _v.dot(side);

      // Lateral: Pacejka simplificado + cerda para baixa velocidade (não escorrega parado).
      // Sensibilidade à carga: dobrar a carga não dobra a aderência (por isso a transferência
      // de peso numa curva tira aderência do eixo e o carro sai de frente/de traseira).
      const fz0 = (cfg.massa * 9.81) / 4;
      const D = p.mu * fz * Math.max(0.6, 1 - p.sensibilidadeCarga * (fz / fz0 - 1));
      rd.D = D;
      const alfa = Math.atan2(rd.vy, Math.max(Math.abs(rd.vx), 3));
      const fyPacejka = -D * Math.sin(p.C * Math.atan(p.B * alfa));
      // Relaxação: a força lateral cresce ao longo de ~relaxacao metros rodados.
      const kRelax = Math.min(1, (Math.max(Math.abs(rd.vx), 0.5) * dt) / p.relaxacao);
      rd.fyRelax += (fyPacejka - rd.fyRelax) * kRelax;
      let fy = rd.fyRelax;
      const baixa = Math.max(0, 1 - Math.hypot(rd.vx, rd.vy) / 2);
      rd.cerdaLat = rd.cerdaLat * (baixa > 0 ? 1 : 0.5) + rd.vy * dt;
      fy -= baixa * p.rigidezCerdaLat * rd.cerdaLat;
      if (Math.abs(fy) > D) {
        fy = Math.sign(fy) * D;
        if (baixa > 0) {
          const lim = D / p.rigidezCerdaLat;
          rd.cerdaLat = Math.max(-lim, Math.min(lim, rd.cerdaLat));
        }
      }
      rd.fy = fy;

      // Elipse de atrito: o que sobra para a longitudinal (mínimo de 30% para tração/frenagem).
      const fxMax = Math.max(0.3 * D, Math.sqrt(Math.max(0, D * D - fy * fy)));
      entradas.push({ noChao: true, vx: rd.vx, fxMax, fz });
      frentes.push(fwd);
      lados.push(side);
    }

    // 2) Trem de força + longitudinal (sub-passos)
    this.trem.passo(dt / subpassos, subpassos, cmd, entradas, cfg.massa);

    // 3) Aplica impulsos
    this.torqueAutoalinhante = 0;
    for (let i = 0; i < 4; i++) {
      const rd = this.rodas[i];
      rd.rotacao += this.trem.omegaRoda[i] * dt;
      if (!rd.noChao) continue;
      let fx = this.trem.fx[i];
      let fy = rd.fy;
      const D = rd.D;
      // Roda travada ou patinando: o pneu inteiro desliza e o atrito aponta contra o
      // deslizamento total — quase nada sobra para segurar de lado (travar = perder a direção;
      // freio de mão puxado = traseira solta).
      const sx = this.trem.omegaRoda[i] * r - rd.vx;
      const deslize = suave(0.15, 0.6, Math.abs(sx) / Math.max(Math.abs(rd.vx), 3));
      if (deslize > 0) {
        const vs = Math.hypot(sx, rd.vy);
        if (vs > 0.05) {
          const fyDesl = (-D * (1 - p.quedaDeslize) * rd.vy) / vs;
          fy += (fyDesl - fy) * deslize;
        }
      }
      const tot = Math.hypot(fx, fy);
      if (tot > D && tot > 0) {
        // Pneu saturado: a lateral cede (patinar/travar faz perder direção).
        const fyMax = Math.sqrt(Math.max(0, D * D - fx * fx));
        fy = Math.sign(fy) * Math.min(Math.abs(fy), fyMax);
        if (Math.abs(fx) > D) fx = Math.sign(fx) * D;
      }
      rd.fy = fy;
      rd.uso = D > 0 ? Math.max(deslize, Math.min(1, Math.hypot(fx, fy) / D)) : 0;
      // Suspensão no ponto de contato; forças do pneu no centro de rolagem do eixo
      // (a geometria da suspensão “levanta” o ponto onde a força lateral atua no chassi).
      const pz = rd.pontoContato;
      corpo.applyImpulseAtPoint({ x: _cima.x * rd.fz * dt, y: _cima.y * rd.fz * dt, z: _cima.z * rd.fz * dt }, { x: pz.x, y: pz.y, z: pz.z }, true);
      const hRC = rd.dianteira ? s.centroRolagemDianteiro : s.centroRolagemTraseiro;
      const F = new THREE.Vector3().addScaledVector(frentes[i], fx).addScaledVector(lados[i], fy);
      const pRC = pz.clone().addScaledVector(_cima, hRC);
      corpo.applyImpulseAtPoint({ x: F.x * dt, y: F.y * dt, z: F.z * dt }, { x: pRC.x, y: pRC.y, z: pRC.z }, true);
      if (rd.dianteira) this.torqueAutoalinhante += -fy * p.rastro;
    }

    // 4) Arrasto aerodinâmico
    const lv = corpo.linvel();
    const vel = Math.hypot(lv.x, lv.y, lv.z);
    if (vel > 0.1) {
      const k = 0.5 * 1.2 * cfg.aero.cdA * vel * dt;
      corpo.applyImpulse({ x: -lv.x * k, y: -lv.y * k, z: -lv.z * k }, true);
    }
  }
}
