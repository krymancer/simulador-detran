/**
 * Movimento da cabeça do motorista no cockpit. Sem force feedback, é o que faz o corpo
 * “sentir” o carro: a cabeça é uma massa no pescoço (mola + amortecedor) que fica para
 * trás quando o carro acelera — vai para a frente na freada, para fora na curva, afunda
 * nas lombadas — mais a vibração do motor (forte na lenta, mais ainda no 3 cilindros),
 * a textura do asfalto conforme a velocidade e trancos (pegou, apagou, batida).
 *
 * Tudo no referencial do carro: +Z frente, +Y cima, +X esquerda.
 */
import * as THREE from 'three';

export interface EntradaCabeca {
  /** Velocidade linear do carro no mundo (m/s). */
  vel: THREE.Vector3;
  /** Orientação do carro no mundo. */
  rot: THREE.Quaternion;
  /** Tempo de simulação que passou desde o quadro anterior (s). 0 = pausado. */
  dtSim: number;
  rpm: number;
  rpmLenta: number;
  ligado: boolean;
  cilindros: number;
  /** Carga do motor 0..1. */
  carga: number;
}

/** Frequência natural do pescoço (Hz) e amortecimento: ~4 cm de deslocamento por g. */
const F_PESCOCO = 2.4;
const ZETA = 0.55;
const MAX_DESLOC = 0.09;

export class MovimentoCabeca {
  /** Deslocamento da cabeça (m, referencial do carro). */
  readonly desloc = new THREE.Vector3();
  /** Rotação extra da câmera (rad): x = arfagem (+ olha para cima), z = rolagem (+ inclina para a esquerda). */
  readonly giro = new THREE.Vector3();
  intensidade = 1;

  /** Estado da mola do pescoço (sem as vibrações, que não podem realimentar a mola). */
  private readonly pos = new THREE.Vector3();
  private readonly velCabeca = new THREE.Vector3();
  private readonly vAnt = new THREE.Vector3();
  private readonly acel = new THREE.Vector3();
  private iniciada = false;
  private t = 0;
  private trancos: { t0: number; dur: number; amp: number; freq: number; vertical: number }[] = [];

  /** Tranco na cabeça: `amp` em metros, decai em `dur` s, oscilando a `freq` Hz. */
  tranco(amp: number, dur = 0.35, freq = 9, vertical = 0.6): void {
    this.trancos.push({ t0: this.t, dur, amp, freq, vertical });
    if (this.trancos.length > 6) this.trancos.shift();
  }

  reiniciar(): void {
    this.iniciada = false;
    this.desloc.set(0, 0, 0);
    this.pos.set(0, 0, 0);
    this.velCabeca.set(0, 0, 0);
    this.acel.set(0, 0, 0);
    this.trancos.length = 0;
  }

  atualizar(dt: number, e: EntradaCabeca): void {
    if (dt <= 0) return;
    this.t += dt;
    const k = this.intensidade;

    // 1) Aceleração do carro no referencial dele (só o que muda de velocidade, sem a gravidade).
    if (!this.iniciada) {
      this.vAnt.copy(e.vel);
      this.iniciada = true;
    }
    if (e.dtSim > 0) {
      const a = e.vel.clone().sub(this.vAnt).divideScalar(e.dtSim);
      a.applyQuaternion(e.rot.clone().invert());
      // filtra o “serrilhado” de quadros com 3 ou 4 passos de física
      this.acel.lerp(a, 1 - Math.exp(-dt / 0.035));
      this.vAnt.copy(e.vel);
    }

    // 2) Pescoço: x'' = −ω²x − 2ζωx' − a (a cabeça fica para trás da aceleração)
    const w = 2 * Math.PI * F_PESCOCO;
    const passos = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / passos;
    const alvo = this.acel.clone().multiplyScalar(-k);
    alvo.y *= 0.6; // na vertical o banco e a coluna seguram mais
    for (let i = 0; i < passos; i++) {
      const ax = alvo.x - w * w * this.pos.x - 2 * ZETA * w * this.velCabeca.x;
      const ay = alvo.y - w * w * this.pos.y - 2 * ZETA * w * this.velCabeca.y;
      const az = alvo.z - w * w * this.pos.z - 2 * ZETA * w * this.velCabeca.z;
      this.velCabeca.x += ax * h;
      this.velCabeca.y += ay * h;
      this.velCabeca.z += az * h;
      this.pos.addScaledVector(this.velCabeca, h);
    }
    this.pos.clampLength(0, MAX_DESLOC);
    this.desloc.copy(this.pos);

    // A cabeça inclina junto: para a frente na freada, para o lado na curva.
    // (câmera: rotateX + = olha para cima; rotateZ + = inclina para a esquerda)
    this.giro.set(-this.desloc.z * 0.55, 0, this.desloc.x * 0.3);

    // 3) Vibrações (soma de senos de frequências “tortas”: não repete nem serrilha a 60 fps)
    const t = this.t;
    const ruido = (f: number, fase: number) =>
      Math.sin(t * f * 6.283 + fase) * 0.55 + Math.sin(t * f * 1.618 * 6.283 + fase * 2.1) * 0.3 + Math.sin(t * f * 2.414 * 6.283 + fase * 0.7) * 0.15;

    let vib = 0;
    if (e.ligado) {
      // Lenta: motor solto nos coxins; 3 cilindros é bem mais áspero.
      const lenta = 1 - Math.min(1, Math.max(0, (e.rpm - e.rpmLenta - 100) / 900));
      const aspero = e.cilindros === 3 ? 1.7 : 1;
      vib = (0.00035 * lenta + 0.00012 * Math.min(1, e.rpm / 6000) * (0.4 + e.carga)) * aspero;
    }
    const vel = e.vel.length();
    const rua = Math.min(1.3, vel / 22);

    this.desloc.x += (ruido(11.3, 0.3) * vib + ruido(2.1, 1.7) * 0.0012 * rua * rua) * k;
    this.desloc.y += (ruido(13.7, 2.2) * vib * 1.3 + ruido(1.7, 0.4) * 0.0018 * rua * rua + ruido(9.1, 3.1) * 0.0004 * rua) * k;
    this.giro.z += ruido(12.9, 4.4) * vib * 0.9 * k;
    this.giro.x += ruido(1.3, 5.1) * 0.0012 * rua * rua * k;

    // 4) Trancos
    this.trancos = this.trancos.filter((tr) => t - tr.t0 < tr.dur);
    for (const tr of this.trancos) {
      const u = (t - tr.t0) / tr.dur;
      const env = (1 - u) * (1 - u);
      const s = Math.sin((t - tr.t0) * tr.freq * 6.283);
      this.desloc.y += s * tr.amp * tr.vertical * env * k;
      this.desloc.x += Math.sin((t - tr.t0) * tr.freq * 1.37 * 6.283) * tr.amp * 0.5 * env * k;
      this.giro.z += s * tr.amp * 0.9 * env * k;
    }
  }
}
