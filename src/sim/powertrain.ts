import { CarConfig, RPM_PARA_RADS } from './carConfig';

/** Entrada do motorista, já normalizada. */
export interface Comandos {
  volante: number;     // −1 (esquerda) … +1 (direita)
  acelerador: number;  // 0…1
  freio: number;       // 0…1
  embreagem: number;   // 0 = solta, 1 = pedal no fundo
  freioDeMao: boolean;
  /** Marcha que o motorista está tentando engatar: −1 = ré, 0 = neutro, 1..5 */
  marcha: number;
  /** Botão de partida pressionado (segurar para dar partida). */
  partida: boolean;
  /** Pedido de desligar a ignição (borda). */
  desligar: boolean;
}

export const COMANDOS_NEUTROS: Comandos = {
  volante: 0, acelerador: 0, freio: 0, embreagem: 0, freioDeMao: true, marcha: 0, partida: false, desligar: false,
};

/** O que o trem de força precisa saber de cada roda a cada passo. */
export interface EntradaRoda {
  noChao: boolean;
  /** Velocidade do ponto de contato na direção da roda (m/s). */
  vx: number;
  /** Força máxima longitudinal disponível (elipse de atrito já descontada). */
  fxMax: number;
  fz: number;
}

export type EventoTrem = 'apagou' | 'pegou' | 'arranhou';

function interp(curva: [number, number][], x: number): number {
  if (x <= curva[0][0]) return curva[0][1];
  for (let i = 1; i < curva.length; i++) {
    if (x <= curva[i][0]) {
      const [x0, y0] = curva[i - 1];
      const [x1, y1] = curva[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return curva[curva.length - 1][1];
}

/**
 * Motor + embreagem + câmbio + diferencial aberto + giro das 4 rodas + força
 * longitudinal dos pneus. Roda em sub-passos (ex.: 1 kHz) porque o acoplamento
 * embreagem/pneu é rígido. É puro (sem Rapier) para poder ser testado isolado.
 *
 * Ordem das rodas: 0 = dianteira esquerda, 1 = dianteira direita,
 *                  2 = traseira esquerda, 3 = traseira direita. Tração dianteira.
 */
export class TremDeForca {
  readonly cfg: CarConfig;

  // Estado do motor
  omegaMotor = 0;
  ligado = false;
  ignicao = false;
  private integralLenta = 0;
  /** Logo após pegar, o motor ainda está subindo de giro: limiar de apagar mais baixo. */
  private tempoDesdePegou = 99;
  aceleradorEfetivo = 0;
  torqueMotor = 0;

  // Embreagem / câmbio
  marchaEngatada = 0; // −1, 0, 1..5
  torqueEmbreagem = 0;
  capacidadeEmbreagem = 0;
  patinando = false;
  arranhando = false;

  // Rodas
  readonly omegaRoda = [0, 0, 0, 0];
  private readonly cerda = [0, 0, 0, 0];
  readonly fx = [0, 0, 0, 0];
  readonly travada = [false, false, false, false];

  readonly eventos: EventoTrem[] = [];

  constructor(cfg: CarConfig) {
    this.cfg = cfg;
  }

  get rpm(): number {
    return this.omegaMotor / RPM_PARA_RADS;
  }

  relacaoTotal(marcha = this.marchaEngatada): number {
    const c = this.cfg.cambio;
    if (marcha === 0) return 0;
    if (marcha < 0) return -c.re * c.diferencial;
    return c.relacoes[marcha - 1] * c.diferencial;
  }

  private atritoMotor(w: number): number {
    const [a, b, c] = this.cfg.motor.atrito;
    const aw = Math.abs(w);
    return a + b * aw + c * aw * aw;
  }

  /** Torque líquido do motor no virabrequim (já com atrito/freio-motor). */
  private calcTorqueMotor(dt: number, cmd: Comandos): number {
    const m = this.cfg.motor;
    const w = this.omegaMotor;
    const rpm = w / RPM_PARA_RADS;

    let torque = 0;
    if (this.ligado) {
      // Controle de marcha lenta (PI), como a ECU faz com o corpo de borboleta.
      const alvo = m.rpmMarchaLenta * RPM_PARA_RADS;
      const erro = (alvo - w) / alvo;
      this.integralLenta = Math.min(m.marchaLentaMaxAcelerador, Math.max(0, this.integralLenta + erro * dt * 0.6));
      const lenta = Math.min(m.marchaLentaMaxAcelerador, Math.max(0, 0.9 * erro + this.integralLenta));
      let acel = Math.max(cmd.acelerador, lenta);
      if (rpm > m.rpmCorte) acel = 0; // corte de giro
      this.aceleradorEfetivo = acel;
      const atrito = this.atritoMotor(w);
      // Borboleta progressiva: em giro baixo, pouca abertura já dá quase todo o torque
      // (o coletor enche rápido); em giro alto a resposta fica linear.
      const k = 1 + 2.5 * Math.max(0, 1 - rpm / 6000);
      const carga = 1 - Math.pow(1 - acel, k);
      torque = carga * (interp(m.curvaTorque, rpm) + atrito) - atrito * Math.sign(w || 1);
    } else {
      this.aceleradorEfetivo = 0;
      // Motor parado: compressão + atrito, que se opõe ao giro (suave perto de zero).
      torque = -m.atritoDesligado * Math.tanh(w / 2);
      if (cmd.partida && this.ignicao) {
        // Motor de partida perde força conforme gira.
        torque += m.torqueMotorPartida * Math.max(0, 1 - rpm / 400);
      }
    }
    return torque;
  }

  private tentarEngatar(cmd: Comandos): void {
    const desejada = cmd.marcha;
    if (desejada === this.marchaEngatada) {
      this.arranhando = false;
      return;
    }
    if (desejada === 0) {
      this.marchaEngatada = 0;
      this.arranhando = false;
      return;
    }
    // Sincronizado só funciona com embreagem pisada, ou se as rotações já batem.
    const wCaixa = this.relacaoTotal(desejada) * 0.5 * (this.omegaRoda[0] + this.omegaRoda[1]);
    const rotacoesBatem = Math.abs(wCaixa - this.omegaMotor) < 25;
    // Ré não é sincronizada: precisa do carro (quase) parado.
    const reOk = desejada > 0 || Math.abs(this.omegaRoda[0] + this.omegaRoda[1]) < 2;
    if ((cmd.embreagem > 0.7 || rotacoesBatem) && reOk) {
      this.marchaEngatada = desejada;
      this.arranhando = false;
    } else {
      if (!this.arranhando) this.eventos.push('arranhou');
      this.arranhando = true;
      this.marchaEngatada = 0;
    }
  }

  /**
   * Avança `passos` sub-passos de `dts`. `massa` é a massa do carro, usada para
   * acoplar a aceleração do carro ao giro das rodas dentro do sub-passo.
   * Retorna (em this.fx) a força longitudinal média de cada pneu.
   */
  passo(dts: number, passos: number, cmd: Comandos, rodas: EntradaRoda[], massa: number): void {
    const cfg = this.cfg;
    const m = cfg.motor;

    // Ignição / partida
    if (cmd.desligar && (this.ligado || this.ignicao)) {
      this.ligado = false;
      this.ignicao = false;
    }
    if (cmd.partida) this.ignicao = true;

    this.tentarEngatar(cmd);

    // Embreagem: pedal → capacidade de torque
    const solto = 1 - cmd.embreagem;
    const e = cfg.embreagem;
    const x = Math.min(1, Math.max(0, (solto - e.inicioPega) / (e.fimPega - e.inicioPega)));
    this.capacidadeEmbreagem = e.torqueMax * Math.pow(x, e.expoente);

    // Freios (torque máximo por roda) + resistência à rolagem
    const freio = cmd.freio * cmd.freio * 0.7 + cmd.freio * 0.3; // pedal levemente progressivo
    const torqueFreio = [
      freio * cfg.freio.torqueMaxDianteiro,
      freio * cfg.freio.torqueMaxDianteiro,
      freio * cfg.freio.torqueMaxTraseiro + (cmd.freioDeMao ? cfg.freio.freioDeMao : 0),
      freio * cfg.freio.torqueMaxTraseiro + (cmd.freioDeMao ? cfg.freio.freioDeMao : 0),
    ];

    const r = cfg.roda.raio;
    const Iw = cfg.roda.inercia;
    const Ie = m.inercia;
    const p = cfg.pneu;
    const G = this.relacaoTotal();
    const eta = cfg.cambio.eficiencia;

    const fxSoma = [0, 0, 0, 0];
    let dvCarro = 0; // variação da velocidade do carro dentro do passo
    let somaEmbreagem = 0;
    let patinou = false;

    for (let s = 0; s < passos; s++) {
      // 1) Força longitudinal de cada pneu (modelo de cerdas: rigidez + amortecimento)
      const f = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        const rd = rodas[i];
        if (!rd.noChao || rd.fz <= 0) {
          this.cerda[i] *= 0.9;
          continue;
        }
        const vx = rd.vx + dvCarro;
        const escorregamento = this.omegaRoda[i] * r - vx;
        const kd = p.rigidezLongitudinal / Math.max(Math.abs(vx), 5);
        this.cerda[i] += escorregamento * dts;
        let fi = kd * escorregamento + p.rigidezCerdaLong * this.cerda[i];
        const lim = rd.fxMax;
        if (fi > lim || fi < -lim) {
          fi = Math.sign(fi) * lim;
          const cmax = lim / p.rigidezCerdaLong;
          this.cerda[i] = Math.min(cmax, Math.max(-cmax, this.cerda[i]));
        }
        f[i] = fi;
      }

      // 2) Motor
      const Te = this.calcTorqueMotor(dts, cmd);
      this.torqueMotor = Te;

      // 3) Embreagem: torque que igualaria as rotações neste sub-passo, limitado à capacidade.
      let Tc = 0;
      if (G !== 0 && this.capacidadeEmbreagem > 0) {
        const wCaixa = G * 0.5 * (this.omegaRoda[0] + this.omegaRoda[1]);
        const carga = -0.5 * (f[0] + f[1]) * r; // torque médio que o chão faz nas rodas motrizes
        const num = this.omegaMotor - wCaixa + dts * (Te / Ie - (G * carga) / Iw);
        const den = dts * (1 / Ie + (G * G * eta) / (2 * Iw));
        const travar = num / den;
        const cap = this.capacidadeEmbreagem;
        Tc = Math.min(cap, Math.max(-cap, travar));
        if (Math.abs(travar) > cap) patinou = true;
      }
      somaEmbreagem += Tc;

      // 4) Integra motor e rodas
      this.omegaMotor += (dts * (Te - Tc)) / Ie;
      for (let i = 0; i < 4; i++) {
        const tracao = i < 2 ? 0.5 * Tc * G * eta : 0;
        let w = this.omegaRoda[i] + (dts * (tracao - f[i] * r)) / Iw;
        // Freio + rolagem como atrito seco: não pode inverter o giro.
        const rol = rodas[i].noChao ? p.resistenciaRolagem * rodas[i].fz * r : 0;
        const dwFreio = (dts * (torqueFreio[i] + rol)) / Iw;
        if (Math.abs(w) <= dwFreio) {
          w = 0;
          this.travada[i] = torqueFreio[i] > 0;
        } else {
          w -= Math.sign(w) * dwFreio;
          this.travada[i] = false;
        }
        this.omegaRoda[i] = w;
        fxSoma[i] += f[i];
      }

      // 5) O carro acelera junto (acoplamento dentro do passo)
      dvCarro += ((f[0] + f[1] + f[2] + f[3]) / massa) * dts;

      // 6) Liga / apaga
      this.tempoDesdePegou += dts;
      const limiarApaga = this.tempoDesdePegou < 1.5 ? m.rpmPega * 0.7 : m.rpmApaga;
      if (this.ligado && this.omegaMotor < limiarApaga * RPM_PARA_RADS) {
        this.ligado = false;
        this.eventos.push('apagou');
      } else if (
        !this.ligado &&
        this.ignicao &&
        this.omegaMotor > (cmd.partida ? m.rpmPega : m.rpmTranco) * RPM_PARA_RADS
      ) {
        this.ligado = true;
        this.integralLenta = 0.15;
        this.tempoDesdePegou = 0;
        this.eventos.push('pegou');
      }
    }

    for (let i = 0; i < 4; i++) this.fx[i] = fxSoma[i] / passos;
    this.torqueEmbreagem = somaEmbreagem / passos;
    this.patinando = patinou;
  }

  /** Teleporta / reinicia (respawn). */
  reiniciar(): void {
    this.omegaMotor = 0;
    this.ligado = false;
    this.ignicao = false;
    this.marchaEngatada = 0;
    this.omegaRoda.fill(0);
    this.cerda.fill(0);
    this.fx.fill(0);
  }
}
