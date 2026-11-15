import * as THREE from 'three';
import { Simulacao } from '../sim/simulation';
import { Comandos, EventoTrem } from '../sim/powertrain';
import { dentroDaZona, Obstaculo, Semaforo, Zona } from '../world/parser';
import { CodigoFalta, LIMITE_PONTOS, PONTOS, REGRAS, TEMPO_BALIZA } from './regras';

export type CorSemaforo = 'verde' | 'amarelo' | 'vermelho';

export function corSemaforo(s: Semaforo, t: number): CorSemaforo {
  const { verde, amarelo, vermelho } = s.tempos;
  const ciclo = verde + amarelo + vermelho;
  const x = (((t + s.defasagem) % ciclo) + ciclo) % ciclo;
  if (x < verde) return 'verde';
  if (x < verde + amarelo) return 'amarelo';
  return 'vermelho';
}

export interface Falta {
  codigo: CodigoFalta;
  descricao: string;
  gravidade: (typeof REGRAS)[CodigoFalta]['gravidade'];
  tempo: number;
}

export interface Mensagem {
  texto: string;
  tempo: number;
  tipo: 'info' | 'falta' | 'eliminatoria';
}

/** Estado do painel que vem de fora da física (botões do motorista). */
export interface Cabine {
  seta: 'esquerda' | 'direita' | null;
  cinto: boolean;
}

const _p = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Avaliador da prova: observa a simulação a cada passo e registra as faltas.
 */
export class Prova {
  readonly faltas: Falta[] = [];
  readonly mensagens: Mensagem[] = [];
  readonly obstaculosTocados = new Set<Obstaculo>();
  iniciada = false;
  encerrada = false;
  tempoInicio = 0;

  private readonly sim: Simulacao;
  private contato = new Set<Obstaculo>();
  private naCalcada = false;
  private foraCalcadaTempo = 0;
  private cintoAvaliado = false;
  private setaAvaliada = false;
  private ultimoTempoSeta = -999;
  private freioMaoTempo = 0;
  private freioMaoMultado = false;
  private banguelaTempo = 0;
  private banguelaMultada = false;
  private ultimoArranhou = -999;
  private paradoTempo = 0;
  private ancoraRampa: { pos: THREE.Vector3; frente: THREE.Vector3 } | null = null;
  private faixaMultada = false;
  private dentroLinha = new Map<Zona, boolean>();
  private estadoPare = new Map<Zona, { dentro: boolean; parou: boolean }>();
  private derrubados = new Set<Obstaculo>();
  balizaInicio: number | null = null;
  balizaConcluida: number | null = null;
  private balizaEstourou = false;
  private balizaParadoTempo = 0;

  constructor(sim: Simulacao) {
    this.sim = sim;
  }

  get pontos(): number {
    return this.faltas.reduce((s, f) => s + PONTOS[f.gravidade], 0);
  }

  get eliminado(): boolean {
    return this.faltas.some((f) => f.gravidade === 'eliminatoria');
  }

  get aprovado(): boolean {
    return !this.eliminado && this.pontos <= LIMITE_PONTOS;
  }

  avisar(texto: string, tipo: Mensagem['tipo'] = 'info'): void {
    this.mensagens.push({ texto, tempo: this.sim.tempo, tipo });
  }

  private falta(codigo: CodigoFalta): void {
    if (!this.iniciada || this.encerrada) return;
    const r = REGRAS[codigo];
    this.faltas.push({ codigo, descricao: r.descricao, gravidade: r.gravidade, tempo: this.sim.tempo });
    this.avisar(
      `${r.descricao} (${r.gravidade === 'eliminatoria' ? 'ELIMINATÓRIA' : `${r.gravidade}, ${PONTOS[r.gravidade]} pt`})`,
      r.gravidade === 'eliminatoria' ? 'eliminatoria' : 'falta',
    );
  }

  encerrar(): void {
    if (this.encerrada) return;
    this.encerrada = true;
    this.avisar(this.aprovado ? 'Prova encerrada: APROVADO' : 'Prova encerrada: REPROVADO', this.aprovado ? 'info' : 'eliminatoria');
  }

  /** Cantos da carroceria (mundo, no plano do chão) e ponto do para-choque dianteiro. */
  private geometria() {
    const corpo = this.sim.carro.corpo;
    const cb = this.sim.carro.cfg.carroceria;
    const t = corpo.translation();
    const r = corpo.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    const pos = new THREE.Vector3(t.x, t.y, t.z);
    const frente = new THREE.Vector3(0, 0, 1).applyQuaternion(_q);
    const yBaixo = -this.sim.carro.cfg.alturaCG + 0.2;
    const zF = cb.centro[2] + cb.meiaComprimento;
    const zT = cb.centro[2] - cb.meiaComprimento;
    const w = cb.meiaLargura;
    const canto = (x: number, z: number) => new THREE.Vector3(x, yBaixo, z).applyQuaternion(_q).add(pos);
    return {
      pos,
      frente,
      cantos: [canto(w, zF), canto(-w, zF), canto(w, zT), canto(-w, zT)],
      paraChoque: canto(0, zF),
    };
  }

  /** Obstáculo (círculo no plano XZ) toca a carroceria (retângulo)? */
  private tocaObstaculo(o: Obstaculo): boolean {
    const corpo = this.sim.carro.corpo;
    const cb = this.sim.carro.cfg.carroceria;
    const t = corpo.translation();
    const r = corpo.rotation();
    _q.set(r.x, r.y, r.z, r.w).invert();
    _p.set(o.x - t.x, 0, o.z - t.z).applyQuaternion(_q);
    const cx = Math.max(-cb.meiaLargura, Math.min(cb.meiaLargura, _p.x));
    const cz = Math.max(cb.centro[2] - cb.meiaComprimento, Math.min(cb.centro[2] + cb.meiaComprimento, _p.z));
    return Math.hypot(_p.x - cx, _p.z - cz) < o.raio;
  }

  atualizar(dt: number, cmd: Comandos, cabine: Cabine, eventos: EventoTrem[]): void {
    const sim = this.sim;
    const carro = sim.carro;
    const trem = carro.trem;
    const t = sim.tempo;
    const v = carro.velocidadeLongitudinal();
    const vAbs = Math.abs(v);
    const g = this.geometria();

    for (const e of eventos) {
      if (e === 'pegou' && !this.iniciada) {
        this.iniciada = true;
        this.tempoInicio = t;
        this.avisar('Prova iniciada. Boa sorte!');
      } else if (e === 'apagou') {
        this.falta('motor_apagou');
      } else if (e === 'arranhou') {
        if (t - this.ultimoArranhou > 3) this.falta('arranhou_marcha');
        this.ultimoArranhou = t;
      }
    }
    if (!this.iniciada || this.encerrada) return;

    // Seta / cinto na saída
    if (cabine.seta) this.ultimoTempoSeta = t;
    if (!this.cintoAvaliado && vAbs > 0.5) {
      this.cintoAvaliado = true;
      if (!cabine.cinto) this.falta('sem_cinto');
    }
    if (!this.setaAvaliada && g.pos.distanceTo(sim.mapa.spawn.posicao) > 2.5) {
      this.setaAvaliada = true;
      if (t - this.ultimoTempoSeta > 6) this.falta('sem_seta');
    }

    // Freio de mão puxado andando
    if (cmd.freioDeMao && vAbs > 1.5) {
      this.freioMaoTempo += dt;
      if (this.freioMaoTempo > 1 && !this.freioMaoMultado) {
        this.freioMaoMultado = true;
        this.falta('freio_de_mao');
      }
    } else if (!cmd.freioDeMao) {
      this.freioMaoTempo = 0;
      this.freioMaoMultado = false;
    }

    // Banguela: descendo, rápido, sem marcha ou com embreagem no fundo
    const vy = carro.corpo.linvel().y;
    if (vAbs > 3 && vy < -0.15 && (trem.marchaEngatada === 0 || cmd.embreagem > 0.8)) {
      this.banguelaTempo += dt;
      if (this.banguelaTempo > 2.5 && !this.banguelaMultada) {
        this.banguelaMultada = true;
        this.falta('banguela');
      }
    } else {
      this.banguelaTempo = 0;
      this.banguelaMultada = false;
    }

    // Calçada
    const naCalcada = carro.rodas.some((r) => r.noChao && r.colisorChao !== null && sim.tipoColisor.get(r.colisorChao) === 'calcada');
    // Uma falta por subida: só rearma depois de 1,5 s com as quatro rodas fora da calçada.
    if (naCalcada) {
      if (!this.naCalcada) this.falta('subiu_calcada');
      this.naCalcada = true;
      this.foraCalcadaTempo = 0;
    } else if (this.naCalcada) {
      this.foraCalcadaTempo += dt;
      if (this.foraCalcadaTempo > 1.5) this.naCalcada = false;
    }

    // Balizas e cones
    for (const o of sim.mapa.obstaculos) {
      const toca = this.tocaObstaculo(o);
      if (toca && !this.contato.has(o)) {
        this.contato.add(o);
        this.obstaculosTocados.add(o);
        this.falta(o.tipo === 'cone' ? 'tocou_cone' : 'tocou_baliza');
      } else if (!toca) {
        this.contato.delete(o);
      }
    }

    // Baliza derrubada
    for (const o of sim.mapa.obstaculos) {
      if (o.tipo === 'baliza' && !this.derrubados.has(o) && sim.derrubado(o)) {
        this.derrubados.add(o);
        this.obstaculosTocados.add(o);
        this.falta('derrubou_baliza');
      }
    }

    // Parado?
    this.paradoTempo = vAbs < 0.05 ? this.paradoTempo + dt : 0;

    for (const z of sim.mapa.zonas) {
      if (z.tipo === 'rampa') {
        if (!dentroDaZona(z, g.pos, _tmp)) {
          this.ancoraRampa = null;
          continue;
        }
        if (!this.ancoraRampa && this.paradoTempo > 0.5) {
          this.ancoraRampa = { pos: g.pos.clone(), frente: g.frente.clone() };
        }
        if (this.ancoraRampa) {
          const d = _tmp.copy(g.pos).sub(this.ancoraRampa.pos).dot(this.ancoraRampa.frente);
          if (d < -0.4 && trem.marchaEngatada !== -1) {
            this.falta('recuou_rampa');
            this.ancoraRampa = null;
          } else if (d > 1.5) {
            this.ancoraRampa = null;
          }
        }
      } else if (z.tipo === 'faixa_pedestre') {
        const sobre = g.cantos.some((c) => dentroDaZona(z, c, _tmp)) || dentroDaZona(z, g.pos, _tmp);
        if (sobre && this.paradoTempo > 1 && !this.faixaMultada) {
          this.faixaMultada = true;
          this.falta('parou_faixa');
        }
        if (!sobre) this.faixaMultada = false;
      } else if (z.tipo === 'linha_parada') {
        const dentro = dentroDaZona(z, g.paraChoque, _tmp);
        const antes = this.dentroLinha.get(z) ?? false;
        if (dentro && !antes && v > 0.3) {
          const sem = sim.mapa.semaforos.find((s) => s.id === z.id);
          if (sem && corSemaforo(sem, t) === 'vermelho') this.falta('avancou_vermelho');
        }
        this.dentroLinha.set(z, dentro);
      } else if (z.tipo === 'pare') {
        const dentro = dentroDaZona(z, g.pos, _tmp) || dentroDaZona(z, g.paraChoque, _tmp);
        const e = this.estadoPare.get(z) ?? { dentro: false, parou: false };
        if (dentro) {
          if (!e.dentro) e.parou = false;
          if (vAbs < 0.1) e.parou = true;
        } else if (e.dentro && v > 0.3 && !e.parou) {
          // Saiu pela frente sem ter parado — só conta no sentido da via (eixo +Z local da zona).
          const sentido = new THREE.Vector3().setFromMatrixColumn(new THREE.Matrix4().copy(z.inversa).invert(), 2).normalize();
          if (sentido.dot(g.frente) > 0.5) this.falta('nao_parou_pare');
        }
        e.dentro = dentro;
        this.estadoPare.set(z, e);
      } else if (z.tipo === 'baliza') {
        if (this.balizaConcluida !== null) continue;
        if (this.balizaInicio === null && trem.marchaEngatada === -1 && g.pos.distanceTo(z.centro) < 12) {
          this.balizaInicio = t;
          this.avisar('Baliza: cronômetro iniciado');
        }
        if (this.balizaInicio !== null) {
          const dentro = g.cantos.every((c) => dentroDaZona(z, c, _tmp));
          this.balizaParadoTempo = dentro && vAbs < 0.05 ? this.balizaParadoTempo + dt : 0;
          if (this.balizaParadoTempo > 1.5) {
            this.balizaConcluida = t - this.balizaInicio;
            this.avisar(`Baliza concluída em ${this.balizaConcluida.toFixed(0)} s`);
          } else if (t - this.balizaInicio > TEMPO_BALIZA && !this.balizaEstourou) {
            this.balizaEstourou = true;
            this.falta('baliza_tempo');
          }
        }
      }
    }
  }
}
