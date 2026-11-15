import * as THREE from 'three';
import { Simulacao } from '../sim/simulation';
import { Comandos, EventoTrem } from '../sim/powertrain';
import { dentroDaZona, Obstaculo, Semaforo, Zona } from '../world/parser';
import type { InfoTrafego } from '../world/infoTrafego';
import { Faixa, projetar } from '../world/vias';
import { Pista } from './pista';
import {
  CodigoFalta,
  DESACELERACAO_BRUSCA,
  Gravidade,
  LIMITE_PONTOS,
  PONTOS,
  REGRAS,
  ROTULO_GRAVIDADE,
  RPM_EXCESSIVA,
  TEMPO_BALIZA,
  TEMPO_RPM_EXCESSIVA,
  VELOCIDADE_MAXIMA,
  VELOCIDADE_MAXIMA_KMH,
} from './regras';

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
  gravidade: Gravidade;
  /** Tempo da simulação (s). Para o relógio da prova use `tempo - prova.tempoInicio`. */
  tempo: number;
  /** Onde o carro estava (mundo, plano XZ). */
  posicao: { x: number; z: number };
}

/** Amostra da trajetória (a cada ~0,5 s). */
export interface PontoTrajetoria {
  t: number;
  x: number;
  z: number;
  /** Velocidade (m/s). */
  v: number;
}

export interface OpcoesProva {
  /** Faixas para as regras de trânsito (contramão, seta, linha divisória). Padrão: as da autoescola, só nesse mapa. */
  faixas?: Faixa[];
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
  /**
   * Farol baixo aceso. OPCIONAL: o main.ts deve passar `ent.farol`. Sem ele (undefined), o
   * examinador não cobra a instrução de acender o farol.
   */
  farol?: boolean;
  /**
   * Pisca-alerta ligado. OPCIONAL: o main.ts deve passar `ent.alerta`. Sem ele, não há a falta
   * de pisca-alerta em movimento nem a cobrança da instrução.
   */
  alerta?: boolean;
}

export type GeometriaCarro = ReturnType<Prova['geometria']>;

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
  private ancoraRampa: { zona: Zona; pos: THREE.Vector3; frente: THREE.Vector3 } | null = null;
  // pisca-alerta em movimento
  private alertaTempo = 0;
  private alertaMultado = false;
  /** Último estado da cabine recebido (o examinador lê farol / pisca-alerta daqui). */
  cabine: Cabine | null = null;
  /**
   * Manobra pedida pelo examinador em curso (meia-volta, estacionar no fim): suspende a
   * cobrança da placa PARE e da seta em conversões, que não fazem sentido no meio da manobra.
   */
  emManobra = false;
  private faixaMultada = false;
  private dentroLinha = new Map<Zona, boolean>();
  private estadoPare = new Map<Zona, { dentro: boolean; parou: boolean }>();
  private derrubados = new Set<Obstaculo>();
  balizaInicio: number | null = null;
  balizaConcluida: number | null = null;
  private balizaEstourou = false;
  private balizaParadoTempo = 0;

  /** Tempo da simulação em que a prova terminou (null = em andamento). */
  tempoFim: number | null = null;
  readonly trajetoria: PontoTrajetoria[] = [];
  readonly pista: Pista;

  private ultimaAmostra = -999;
  private ultimaSetaLado = { esquerda: -999, direita: -999 };
  // excesso de velocidade
  private acimaTempo = 0;
  private abaixoTempo = 0;
  private faltaVelocidade: Falta | null = null;
  private vMaxEpisodio = 0;
  // contramão
  private contramaoTempo = 0;
  private contramaoLivre = 0;
  private contramaoMultada = false;
  // linha divisória
  private sobreLinha = false;
  private foraLinhaTempo = 0;
  // conversão sem seta
  private faixaEstavel: { faixa: Faixa; desde: number; rumo: number; ultimoT: number } | null = null;
  /** Rumo acumulado (sem dar a volta em ±π), para medir giros maiores que 180°. */
  private rumoAcum = 0;
  private rumoAnterior: number | null = null;
  private faixaCandidata: { faixa: Faixa; desde: number } | null = null;
  private percurso: { d: number; rumo: number; rumoVia: number | null; t: number }[] = [];
  private distPercorrida = 0;
  private ultimaConversao = -999;
  // pedestres
  private faixaPedInvadida = new Set<Zona>();
  // freada brusca
  private historicoV: { t: number; v: number }[] = [];
  private freandoForte = false;
  private freadaLivre = 0;
  // rotação
  private rpmTempo = 0;
  private rpmLivre = 0;
  private rpmMultada = false;

  constructor(sim: Simulacao, opcoes: OpcoesProva = {}) {
    this.sim = sim;
    this.pista = new Pista(sim.mapa, opcoes.faixas);
  }

  /** Duração da prova até agora (ou total, se encerrada), em s. */
  get duracao(): number {
    if (!this.iniciada) return 0;
    return (this.tempoFim ?? this.sim.tempo) - this.tempoInicio;
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

  /** Registra uma falta (também usada pelo examinador). Devolve a falta, ou null se a prova não está valendo. */
  registrarFalta(codigo: CodigoFalta, extra: { gravidade?: Gravidade; descricao?: string } = {}): Falta | null {
    if (!this.iniciada || this.encerrada) return null;
    const r = REGRAS[codigo];
    const t = this.sim.carro.corpo.translation();
    const f: Falta = {
      codigo,
      descricao: extra.descricao ?? r.descricao,
      gravidade: extra.gravidade ?? r.gravidade,
      tempo: this.sim.tempo,
      posicao: { x: t.x, z: t.z },
    };
    this.faltas.push(f);
    this.avisarFalta(f);
    return f;
  }

  private avisarFalta(f: Falta): void {
    const el = f.gravidade === 'eliminatoria';
    this.avisar(
      `${f.descricao} (${el ? 'PROVA INTERROMPIDA' : `${ROTULO_GRAVIDADE[f.gravidade]}, ${PONTOS[f.gravidade]} pt`})`,
      el ? 'eliminatoria' : 'falta',
    );
  }

  private falta(codigo: CodigoFalta): void {
    this.registrarFalta(codigo);
  }

  encerrar(): void {
    if (this.encerrada) return;
    this.encerrada = true;
    this.tempoFim = this.sim.tempo;
    this.amostrarTrajetoria(true);
    this.avisar(this.aprovado ? 'Prova encerrada: APROVADO' : 'Prova encerrada: REPROVADO', this.aprovado ? 'info' : 'eliminatoria');
  }

  /** Último instante (tempo da simulação) em que a seta deste lado estava ligada. */
  ultimaSeta(lado: 'esquerda' | 'direita'): number {
    return this.ultimaSetaLado[lado];
  }

  /** Cantos da carroceria (mundo: [esq. frente, dir. frente, esq. trás, dir. trás] — +X local é a esquerda) e para-choque. */
  geometria() {
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

  private amostrarTrajetoria(forcar = false): void {
    const t = this.sim.tempo;
    if (!forcar && t - this.ultimaAmostra < 0.5) return;
    this.ultimaAmostra = t;
    const p = this.sim.carro.corpo.translation();
    this.trajetoria.push({ t, x: p.x, z: p.z, v: Math.abs(this.sim.carro.velocidadeLongitudinal()) });
  }

  atualizar(dt: number, cmd: Comandos, cabine: Cabine, eventos: EventoTrem[], trafego?: InfoTrafego): void {
    const sim = this.sim;
    const carro = sim.carro;
    const trem = carro.trem;
    const t = sim.tempo;
    const v = carro.velocidadeLongitudinal();
    const vAbs = Math.abs(v);
    const g = this.geometria();
    this.cabine = cabine;

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
    if (!this.iniciada || this.encerrada) {
      if (trafego) trafego.eventos.length = 0;
      return;
    }
    this.amostrarTrajetoria();

    // Colisão / atropelamento (vêm do trânsito): o examinador interrompe a prova.
    if (trafego && trafego.eventos.length) {
      const evs = trafego.eventos.splice(0);
      for (const e of evs) this.falta(e === 'atropelou_pedestre' ? 'atropelamento' : 'colisao');
      this.encerrar();
      return;
    }

    // Seta / cinto na saída
    if (cabine.seta) {
      this.ultimoTempoSeta = t;
      this.ultimaSetaLado[cabine.seta] = t;
    }
    if (!this.cintoAvaliado && vAbs > 0.5) {
      this.cintoAvaliado = true;
      if (!cabine.cinto) this.falta('sem_cinto');
    }
    if (!this.setaAvaliada && g.pos.distanceTo(sim.mapa.spawn.posicao) > 2.5) {
      this.setaAvaliada = true;
      if (t - this.ultimoTempoSeta > 6) this.falta('sem_seta');
    }

    // Pisca-alerta com o carro andando (CTB art. 251, I): só vale em imobilização/emergência.
    if (cabine.alerta && vAbs > 2) {
      this.alertaTempo += dt;
      if (this.alertaTempo > 3 && !this.alertaMultado) {
        this.alertaMultado = true;
        this.falta('pisca_alerta_movimento');
      }
    } else if (!cabine.alerta) {
      this.alertaTempo = 0;
      this.alertaMultado = false;
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
        // (cada zona de rampa cuida só da sua âncora: com duas rampas, uma não apaga a da outra)
        if (!dentroDaZona(z, g.pos, _tmp)) {
          if (this.ancoraRampa?.zona === z) this.ancoraRampa = null;
          continue;
        }
        if (!this.ancoraRampa && this.paradoTempo > 0.5) {
          this.ancoraRampa = { zona: z, pos: g.pos.clone(), frente: g.frente.clone() };
        }
        if (this.ancoraRampa?.zona === z) {
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
        } else if (e.dentro && v > 0.3) {
          // Saiu pela frente — só conta no sentido da via (eixo +Z local da zona).
          const sentido = new THREE.Vector3().setFromMatrixColumn(new THREE.Matrix4().copy(z.inversa).invert(), 2).normalize();
          if (sentido.dot(g.frente) > 0.5 && !(this.emManobra && !z.id.startsWith('PN'))) {
            const linhaFerrea = z.id.startsWith('PN');
            if (!e.parou) this.falta(linhaFerrea ? 'nao_parou_linha_ferrea' : 'nao_parou_pare');
            if (linhaFerrea && trafego?.passagemFechada) this.falta('avancou_passagem_nivel');
          }
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

    this.regrasDeTransito(dt, cmd, g, v, trafego);
  }

  // ---------------------------------------------------------------------------
  // Regras de trânsito: velocidade, contramão, linha divisória, seta, pedestre,
  // freada brusca, rotação.

  private regrasDeTransito(dt: number, _cmd: Comandos, g: GeometriaCarro, v: number, trafego?: InfoTrafego): void {
    const sim = this.sim;
    const t = sim.tempo;
    const vAbs = Math.abs(v);
    const lv = sim.carro.corpo.linvel();
    const vel = new THREE.Vector3(lv.x, 0, lv.z);
    const vPlano = vel.length();

    // --- Excesso de velocidade (CTB art. 218): > limite por mais de 2 s; uma falta por
    // episódio, que sobe de gravidade se o excesso aumentar (20 % / 50 %).
    if (vAbs > VELOCIDADE_MAXIMA) {
      this.acimaTempo += dt;
      this.abaixoTempo = 0;
      this.vMaxEpisodio = Math.max(this.vMaxEpisodio, vAbs);
      if (this.acimaTempo > 2) {
        const kmh = this.vMaxEpisodio * 3.6;
        const exc = kmh / VELOCIDADE_MAXIMA_KMH - 1;
        const grav: Gravidade = exc > 0.5 ? 'gravissima' : exc > 0.2 ? 'grave' : 'media';
        const desc = `Excedeu a velocidade máxima de ${VELOCIDADE_MAXIMA_KMH} km/h (${kmh.toFixed(0)} km/h, CTB art. 218)`;
        if (!this.faltaVelocidade) {
          this.faltaVelocidade = this.registrarFalta('excesso_velocidade', { gravidade: grav, descricao: desc });
        } else if (PONTOS[grav] > PONTOS[this.faltaVelocidade.gravidade]) {
          this.faltaVelocidade.gravidade = grav;
          this.faltaVelocidade.descricao = desc;
          this.avisarFalta(this.faltaVelocidade);
        }
      }
    } else if (vAbs < VELOCIDADE_MAXIMA - 1 / 3.6) {
      this.abaixoTempo += dt;
      this.acimaTempo = 0;
      if (this.abaixoTempo > 1) {
        this.faltaVelocidade = null;
        this.vMaxEpisodio = 0;
      }
    }

    // --- Rotação excessiva
    const rpm = sim.carro.trem.rpm;
    if (rpm > RPM_EXCESSIVA) {
      this.rpmTempo += dt;
      this.rpmLivre = 0;
      if (this.rpmTempo > TEMPO_RPM_EXCESSIVA && !this.rpmMultada) {
        this.rpmMultada = true;
        this.falta('rotacao_excessiva');
      }
    } else if (rpm < RPM_EXCESSIVA - 500) {
      this.rpmLivre += dt;
      this.rpmTempo = 0;
      if (this.rpmLivre > 1) this.rpmMultada = false;
    }

    // --- Freada brusca: desaceleração média nos últimos 0,3 s.
    this.historicoV.push({ t, v });
    while (this.historicoV.length > 2 && t - this.historicoV[0].t > 0.3) this.historicoV.shift();
    const h0 = this.historicoV[0];
    const desacel = t - h0.t > 0.2 ? (h0.v - v) / (t - h0.t) : 0;
    if (desacel > DESACELERACAO_BRUSCA && h0.v > 2) {
      if (!this.freandoForte) {
        this.freandoForte = true;
        if (!this.haMotivoParaFrear(g, trafego)) this.falta('freada_brusca');
      }
      this.freadaLivre = 0;
    } else if (desacel < 2) {
      this.freadaLivre += dt;
      if (this.freadaLivre > 1) this.freandoForte = false;
    }

    // --- Pedestre na faixa
    if (trafego) {
      for (const z of sim.mapa.zonas) {
        if (z.tipo !== 'faixa_pedestre') continue;
        // cantos + linha central (o carro é mais comprido que a faixa: pode estar sobre ela com os cantos fora)
        const sobre =
          g.cantos.some((c) => dentroDaZona(z, c, _tmp)) ||
          dentroDaZona(z, g.paraChoque, _tmp) ||
          dentroDaZona(z, g.pos, _tmp) ||
          dentroDaZona(z, _p.copy(g.pos).lerp(g.paraChoque, 0.5), _tmp) ||
          dentroDaZona(z, _p.copy(g.pos).lerp(g.paraChoque, -0.6), _tmp);
        if (!sobre) {
          this.faixaPedInvadida.delete(z);
          continue;
        }
        if (this.faixaPedInvadida.has(z) || vAbs < 0.5) continue;
        const nome = z.nome.toUpperCase();
        const temPedestre = trafego.pedestres.some((p) => p.naFaixa !== null && p.naFaixa.toUpperCase() === nome);
        if (temPedestre) {
          this.faixaPedInvadida.add(z);
          this.falta('preferencia_pedestre');
        }
      }
    }

    if (!this.pista.ativa) return;
    const pista = this.pista;
    const leitura = pista.faixaEm(g.pos);
    const balizaEmCurso = this.emManobra || this.balizaInicio !== null && (this.balizaConcluida === null || t - (this.balizaInicio + this.balizaConcluida) < 8);
    const pertoBaliza = sim.mapa.zonas.some((z) => z.tipo === 'baliza' && Math.hypot(g.pos.x - z.centro.x, g.pos.z - z.centro.z) < 14);

    // --- Contramão: andando para a frente, contra o sentido da faixa, por mais de 1,5 s.
    let naContramao = false;
    let maoUnica = false;
    if (leitura && leitura.confiavel && v > 0.5 && vPlano > 1) {
      if (vel.normalize().dot(leitura.proj.direcao) < -0.5) {
        naContramao = true;
        maoUnica = leitura.proj.faixa.mao === 'unica';
      }
    }
    if (naContramao) {
      this.contramaoTempo += dt;
      this.contramaoLivre = 0;
      if (this.contramaoTempo > 1.5 && !this.contramaoMultada) {
        this.contramaoMultada = true;
        this.falta(maoUnica ? 'contramao_mao_unica' : 'contramao');
      }
    } else {
      this.contramaoLivre += dt;
      if (this.contramaoLivre > 2) {
        this.contramaoTempo = 0;
        this.contramaoMultada = false;
      }
    }

    // --- Linha divisória do anel: um canto da carroceria passa do meio entre as duas faixas.
    if (pista.interno && pista.externo && v > 0.5 && !balizaEmCurso) {
      let cruzou = false;
      if (!pista.noCruzamento(g.pos) && pista.anelCoerente(g.pos)) {
        const ci = projetar(pista.interno, g.pos);
        const ce = projetar(pista.externo, g.pos);
        const [minha, outra] = ci.distancia < ce.distancia ? [pista.interno, pista.externo] : [pista.externo, pista.interno];
        if (Math.min(ci.distancia, ce.distancia) < minha.meiaLargura + 0.5) {
          for (const c of g.cantos) {
            if (pista.noCruzamento(c)) continue;
            const dm = projetar(minha, c).distancia;
            const dout = projetar(outra, c).distancia;
            if (dm - dout > 0.3) {
              cruzou = true;
              break;
            }
          }
        }
      }
      if (cruzou) {
        if (!this.sobreLinha) this.falta('linha_divisoria');
        this.sobreLinha = true;
        this.foraLinhaTempo = 0;
      } else if (this.sobreLinha) {
        this.foraLinhaTempo += dt;
        if (this.foraLinhaTempo > 1.5) this.sobreLinha = false;
      }
    }

    // --- Conversão / mudança de faixa sem seta
    const rumoBruto = Math.atan2(g.frente.x, g.frente.z);
    if (this.rumoAnterior !== null) this.rumoAcum += angulo(rumoBruto - this.rumoAnterior);
    this.rumoAnterior = rumoBruto;
    const rumo = this.rumoAcum;
    if (v < -0.3) {
      // de ré: manobra, não conversão
      this.percurso.length = 0;
      this.faixaCandidata = null;
    } else if (v > 1 && !balizaEmCurso && !pertoBaliza) {
      // 1) troca da faixa estável (anel ↔ avenida, interna ↔ externa, faixa da avenida)
      const nova = leitura && leitura.proj.distancia < leitura.proj.faixa.meiaLargura + 0.2 && leitura.proj.direcao.dot(g.frente) > 0.7
        ? leitura.proj.faixa
        : null;
      if (nova) {
        if (this.faixaEstavel && nova === this.faixaEstavel.faixa) {
          this.faixaEstavel.rumo = rumo;
          this.faixaEstavel.ultimoT = t;
          this.faixaCandidata = null;
        } else {
          if (!this.faixaCandidata || this.faixaCandidata.faixa !== nova) this.faixaCandidata = { faixa: nova, desde: t };
          if (t - this.faixaCandidata.desde > 0.7) {
            const antiga = this.faixaEstavel;
            this.faixaEstavel = { faixa: nova, desde: t, rumo, ultimoT: t };
            this.faixaCandidata = null;
            if (antiga && t - antiga.ultimoT < 20) {
              const giro = rumo - antiga.rumo;
              let lado: 'esquerda' | 'direita';
              if (Math.abs(giro) > 0.45) lado = giro > 0 ? 'esquerda' : 'direita';
              else lado = projetar(antiga.faixa, g.pos).lado > 0 ? 'esquerda' : 'direita';
              this.avaliarSeta(lado, antiga.ultimoT);
            }
          }
        }
      }

      // 2) giro ≥ 60° em ≤ 18 m que não é a curva da própria via (estacionamento, cruzamentos)
      const dPasso = vAbs * dt;
      this.distPercorrida += dPasso;
      const ultimo = this.percurso[this.percurso.length - 1];
      if (!ultimo || this.distPercorrida - ultimo.d > 0.5) {
        // Direção da via por perto (folga grande, sem exigir sentido): explica as curvas do próprio anel.
        const via = pista.faixaEm(g.pos, 2.5);
        let rumoVia: number | null = null;
        if (via) {
          const d = via.proj.direcao;
          const sinal = d.dot(g.frente) < 0 ? -1 : 1;
          rumoVia = Math.atan2(sinal * d.x, sinal * d.z);
        }
        this.percurso.push({ d: this.distPercorrida, rumo, rumoVia, t });
        while (this.percurso.length > 1 && this.distPercorrida - this.percurso[0].d > 18) this.percurso.shift();
        const a = this.percurso[0];
        const b = this.percurso[this.percurso.length - 1];
        const giro = b.rumo - a.rumo;
        if (Math.abs(giro) > Math.PI / 3) {
          const explicado = a.rumoVia !== null && b.rumoVia !== null && Math.abs(giro - angulo(b.rumoVia - a.rumoVia)) < Math.PI / 4;
          if (!explicado) this.avaliarSeta(giro > 0 ? 'esquerda' : 'direita', a.t);
          this.percurso.length = 0;
        }
      }
    }
  }

  /** Conversão para `lado` iniciada em `desde`: a seta desse lado tinha que estar ligada antes. */
  private avaliarSeta(lado: 'esquerda' | 'direita', desde: number): void {
    const t = this.sim.tempo;
    if (t - this.ultimaConversao < 6) return; // mesma manobra
    // A saída da vaga já tem a sua própria falta (sem_seta).
    if (!this.setaAvaliada) return;
    this.ultimaConversao = t;
    if (this.ultimaSetaLado[lado] < desde - 5) this.falta('conversao_sem_seta');
  }

  /** Há pedestre ou carro logo à frente (freada justificada)? */
  private haMotivoParaFrear(g: GeometriaCarro, trafego?: InfoTrafego): boolean {
    if (this.contato.size > 0) return true;
    if (!trafego) return false;
    const aFrente = (p: THREE.Vector3, alcance: number) => {
      const dx = p.x - g.pos.x, dz = p.z - g.pos.z;
      const d = Math.hypot(dx, dz);
      return d < alcance && (d < 4 || (dx * g.frente.x + dz * g.frente.z) / d > 0.3);
    };
    return trafego.pedestres.some((p) => aFrente(p.posicao, 25)) || trafego.carros.some((c) => aFrente(c.posicao, 20));
  }
}

/** Ângulo em (−π, π]. */
function angulo(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
