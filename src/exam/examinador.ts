import * as THREE from 'three';
import type { Simulacao } from '../sim/simulation';
import { px } from '../world/autoescola';
import { dentroDaZona, Zona } from '../world/parser';
import { amostrar, Faixa, projetar } from '../world/vias';
import type { Cabine, Prova } from './exam';
import { dentroRet, distanciaCalcada, ESTACIONAMENTO, TRECHO_MEIO_FIO, VAGAS_90 } from './manobras';
import { deltaS } from './pista';
import { AFASTAMENTO_MEIO_FIO, PRAZO_INSTRUCAO, TEMPO_MEIA_VOLTA, TEMPO_VAGA_90 } from './regras';

/**
 * Examinador da autoescola: dá as instruções do trajeto (voz + texto), confere se o
 * candidato chegou a cada ponto, avalia as manobras pedidas e marca "não seguiu a
 * instrução" quando ele erra o caminho ou não cumpre o que foi pedido.
 *
 * Trajeto — duas voltas: a primeira pelo anel EXTERNO (anti-horário), a segunda pelo
 * INTERNO (horário). Os pontos são calculados de vias.ts, das zonas do mapa e de manobras.ts.
 * (Planta: x cresce para a direita/leste, y para baixo/sul.)
 *
 *  id                    onde                                         o que
 *  0  partida            vaga do estacionamento de baixo (spawn)      cinto + partida
 *  1  saida              saída do estacionamento                      seta, virar à direita → anel externo
 *  2  rampa              reta da direita, subindo (ZONA_RAMPA_1)      parar na subida e sair sem recuar
 *  3  farol              logo depois da rampa, ainda na reta          acender o farol baixo (5 s)
 *  4  semaforo_cima      rua de cima, sentido oeste (LINHA_PARADA_2)  semáforo + faixas de pedestres
 *  5  meio_fio           lado esquerdo, faixa externa, y 820–980 px   seta à direita e parar a ≤ 50 cm do meio-fio
 *  6  alerta             parado no meio-fio                           ligar o pisca-alerta (5 s)
 *  7  retomar            idem                                         desligar o alerta, seta à esquerda, voltar à via
 *  8  passagem_nivel_1   rua de baixo, sentido leste (ZONA_PARE_PN_1) parar antes da linha férrea
 *  9  avenida            embaixo, depois dos trilhos                  virar à esquerda e entrar na avenida
 * 10  semaforo_avenida   fim da avenida (LINHA_PARADA_1)              semáforo
 * 11  vaga_90            em cima à direita, vagas "PARE"              virar à direita e estacionar a 90° (3 min)
 * 12  sair_vaga          idem                                         sair da vaga e seguir pelo anel interno (leste)
 * 13  passagem_nivel_2   rua de baixo, sentido oeste (ZONA_PARE_PN_2) parar antes da linha férrea
 * 14  baliza             lado esquerdo, faixa interna (ZONA_BALIZA)   baliza (5 min)
 * 15  sair_baliza        idem                                         sair da baliza
 * 16  semaforo_esquerda  rua de cima, sentido leste (LINHA_PARADA_3)  semáforo + faixas de pedestres
 * 17  estacionamento     embaixo à direita, faixa interna (oeste)     virar à esquerda e entrar no estacionamento
 * 18  meia_volta         estacionamento de baixo                      meia-volta em três movimentos (com ré, 3 min)
 * 19  estacionar         vaga de onde saiu                            estacionar e aguardar → encerra a prova
 *
 * Errando o caminho, o examinador marca a falta e manda o candidato para a etapa que faz
 * sentido de onde ele está (o anel é fechado: perder uma entrada = dar mais uma volta).
 * Manobra que estoura o prazo ou não é feita: falta e segue para a próxima — nunca trava.
 */
export interface OpcoesExaminador {
  voz?: boolean;
  volumeVoz?: number;
}

interface Contexto {
  pos: THREE.Vector3;
  frente: THREE.Vector3;
  /** Velocidade longitudinal (m/s, negativa = de ré). */
  v: number;
  dt: number;
  /** Tempo da simulação (s). */
  t: number;
  /** Marcha à ré engatada. */
  re: boolean;
  cabine: Cabine | null;
}

interface Etapa {
  id: string;
  /** Falado assim que a etapa começa (opcional). */
  textoInicio?: string;
  /** Instrução principal. Sem `anunciarPerto`, é falada no início. */
  texto: string;
  /** Fala `texto` quando o carro chega a esta distância (m, em linha reta) do ponto. */
  anunciarPerto?: { ponto: THREE.Vector3; distancia: number };
  concluida: (c: Contexto) => boolean;
  /** Errou o caminho / não fez a manobra? (precisa ficar verdadeiro por 0,8 s) */
  errou?: (c: Contexto) => boolean;
  /** Para onde ir quando errar (id de etapa). Padrão: repete esta. */
  seErrar?: string | (() => string);
  /** Prazo (s, contado desde o anúncio). Estourou: `aoEstourar` (padrão: "não seguiu a instrução") e segue. */
  prazo?: number;
  /** Devolve o texto que precede a próxima instrução. */
  aoEstourar?: () => string;
  aoIniciar?: () => void;
  aoConcluir?: (c: Contexto) => void;
  /** Manobra em curso: suspende PARE e seta em conversões na prova (ver Prova.emManobra). */
  manobra?: boolean;
}

const PERTO_FAIXA = 0.8; // folga lateral para "está nesta faixa" (m)
const ERRO = 'Você não seguiu a instrução. ';

export class Examinador {
  private readonly sim: Simulacao;
  private prova: Prova;
  private etapas: Etapa[];
  private indice = 0;
  private anunciado = false;
  private texto: string | null = null;
  private tempoNaEtapa = 0;
  private tempoAnunciado = 0;
  private tempoErro = 0;
  private passouZona = new Map<Zona, boolean>();
  private terminou = false;
  private inicioFalado = false;
  private _voz: boolean;
  private volumeVoz: number;
  private vozPt: SpeechSynthesisVoice | null = null;

  constructor(sim: Simulacao, prova: Prova, opcoes: OpcoesExaminador = {}) {
    this.sim = sim;
    this.prova = prova;
    this._voz = opcoes.voz ?? true;
    this.volumeVoz = opcoes.volumeVoz ?? 1;
    this.etapas = this.montarTrajeto();
    this.etapas[0]?.aoIniciar?.();
    this.prepararVoz();
  }

  get instrucao(): string | null {
    return this.texto;
  }
  get etapa(): number {
    return Math.min(this.indice, this.etapas.length);
  }
  /** Id da etapa atual (null quando acabou). */
  get idEtapa(): string | null {
    return this.etapas[this.indice]?.id ?? null;
  }
  get totalEtapas(): number {
    return this.etapas.length;
  }
  get concluido(): boolean {
    return this.terminou;
  }
  get voz(): boolean {
    return this._voz;
  }
  set voz(v: boolean) {
    this._voz = v;
    if (!v) falador()?.cancel();
  }

  reiniciar(prova: Prova): void {
    this.prova = prova;
    // os fechamentos das etapas guardam a prova: remonta
    this.etapas = this.montarTrajeto();
    this.terminou = false;
    this.texto = null;
    this.irPara(0);
    falador()?.cancel();
  }

  /** Pula para a etapa `id` (depuração e testes). */
  pular(id: string): void {
    this.irPara(this.indiceDe(id));
  }

  atualizar(dt: number): void {
    if (this.terminou) return;
    if (this.prova.encerrada) {
      this.terminou = true;
      this.prova.emManobra = false;
      this.mostrar('Prova encerrada.', false);
      return;
    }
    const etapa = this.etapas[this.indice];
    if (!etapa) return;
    const c = this.contexto(dt);
    this.tempoNaEtapa += dt;

    // Anúncios
    if (!this.anunciado) {
      if (!this.inicioFalado && etapa.textoInicio) this.mostrar(etapa.textoInicio);
      this.inicioFalado = true;
      const perto = etapa.anunciarPerto;
      if (!perto || dist2d(c.pos, perto.ponto) < perto.distancia) {
        this.anunciado = true;
        this.mostrar(etapa.texto);
      }
    } else {
      this.tempoAnunciado += dt;
    }

    if (etapa.concluida(c)) {
      etapa.aoConcluir?.(c);
      if (this.terminou) return;
      this.irPara(this.indice + 1);
      return;
    }

    if (!this.prova.iniciada) return;

    if (etapa.prazo !== undefined && this.anunciado && this.tempoAnunciado > etapa.prazo) {
      const prefixo = etapa.aoEstourar ? etapa.aoEstourar() : this.naoSeguiu();
      if (this.terminou) return;
      this.irPara(this.indice + 1, prefixo);
      return;
    }

    if (etapa.errou) {
      if (etapa.errou(c)) {
        this.tempoErro += dt;
        if (this.tempoErro > 0.8) {
          const prefixo = this.naoSeguiu();
          const destino = typeof etapa.seErrar === 'function' ? etapa.seErrar() : etapa.seErrar;
          this.irPara(destino !== undefined ? this.indiceDe(destino) : this.indice, prefixo);
        }
      } else this.tempoErro = 0;
    }
  }

  // ---------------------------------------------------------------------------

  private naoSeguiu(): string {
    this.prova.registrarFalta('nao_seguiu_instrucao');
    return ERRO;
  }

  private indiceDe(id: string): number {
    const i = this.etapas.findIndex((e) => e.id === id);
    if (i < 0) throw new Error(`etapa desconhecida: ${id}`);
    return i;
  }

  private irPara(i: number, prefixo = ''): void {
    this.indice = i;
    this.anunciado = false;
    this.tempoNaEtapa = 0;
    this.tempoAnunciado = 0;
    this.tempoErro = 0;
    this.inicioFalado = false;
    this.passouZona.clear();
    const e = this.etapas[i];
    this.prova.emManobra = !!e?.manobra;
    if (!e) {
      this.terminou = true;
      return;
    }
    e.aoIniciar?.();
    if (prefixo) {
      // Avisa o erro junto com o que fazer agora.
      const agora = e.anunciarPerto ? (e.textoInicio ?? 'Siga pela pista.') : e.texto;
      this.mostrar(prefixo + agora);
      this.inicioFalado = true;
      if (!e.anunciarPerto) this.anunciado = true;
    }
  }

  private contexto(dt: number): Contexto {
    const carro = this.sim.carro;
    const corpo = carro.corpo;
    const t = corpo.translation();
    const r = corpo.rotation();
    const frente = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    frente.y = 0;
    frente.normalize();
    return {
      pos: new THREE.Vector3(t.x, 0, t.z),
      frente,
      v: carro.velocidadeLongitudinal(),
      dt,
      t: this.sim.tempo,
      re: carro.trem.marchaEngatada === -1,
      cabine: this.prova.cabine,
    };
  }

  private mostrar(texto: string, falar = true): void {
    this.texto = texto;
    if (falar) this.falar(texto);
  }

  private prepararVoz(): void {
    const s = falador();
    if (!s) return;
    const escolher = () => {
      const vozes = s.getVoices();
      this.vozPt =
        vozes.find((v) => v.lang.toLowerCase() === 'pt-br') ??
        vozes.find((v) => v.lang.toLowerCase().startsWith('pt')) ??
        null;
    };
    escolher();
    try {
      s.addEventListener('voiceschanged', escolher);
    } catch {
      /* navegadores antigos */
    }
  }

  private falar(texto: string): void {
    const s = falador();
    if (!s || !this._voz || typeof SpeechSynthesisUtterance === 'undefined') return;
    try {
      s.cancel();
      const u = new SpeechSynthesisUtterance(texto);
      u.lang = 'pt-BR';
      if (this.vozPt) u.voice = this.vozPt;
      u.volume = this.volumeVoz;
      u.rate = 1.02;
      s.speak(u);
    } catch {
      /* sem voz: o texto fica na tela */
    }
  }

  private finalizar(): void {
    this.prova.emManobra = false;
    this.prova.encerrar();
    this.terminou = true;
    this.mostrar(this.prova.aprovado ? 'Prova encerrada. Parabéns, você foi aprovado!' : 'Prova encerrada. Infelizmente, você foi reprovado.');
  }

  // ---------------------------------------------------------------------------
  // Trajeto

  private montarTrajeto(): Etapa[] {
    const mapa = this.sim.mapa;
    const prova = this.prova;
    const pista = prova.pista;
    const int = pista.interno;
    const ext = pista.externo;
    const diagonais = pista.faixas.filter((f) => f.id.startsWith('diagonal'));
    const zona = (nome: string) => mapa.zonas.find((z) => z.nome.toUpperCase() === nome);
    const semAvenida = zona('LINHA_PARADA_1');
    const semCima = zona('LINHA_PARADA_2');
    const semEsquerda = zona('LINHA_PARADA_3');
    const rampa = zona('ZONA_RAMPA_1');
    const pn1 = zona('ZONA_PARE_PN_1');
    const pn2 = zona('ZONA_PARE_PN_2');
    const faixaPed1 = zona('FAIXA_PEDESTRE_1');
    const baliza = mapa.zonas.find((z) => z.tipo === 'baliza');
    const spawn = mapa.spawn.posicao.clone().setY(0);

    const partida: Etapa = {
      id: 'partida',
      texto: 'Coloque o cinto de segurança e dê a partida.',
      concluida: () => prova.iniciada,
    };

    // Fora da autoescola (mapa de teste): só partida e encerrar quando o candidato quiser.
    if (!int || !ext || !diagonais.length || !semAvenida || !semCima || !semEsquerda || !rampa || !pn1 || !pn2 || !baliza) {
      return [
        partida,
        { id: 'livre', texto: 'Siga pela pista. Encerre a prova quando terminar.', concluida: () => false },
      ];
    }

    const diag = diagonais[Math.floor(diagonais.length / 2)];
    const sSpawnExt = projetar(ext, spawn).s;
    const sSpawnInt = projetar(int, spawn).s;
    const sEntradaExt = projetar(ext, diag.pontos[0]).s;
    const sFaixa1Ext = faixaPed1 ? projetar(ext, faixaPed1.centro).s : projetar(ext, semCima.centro).s + 15;
    const sBalizaInt = projetar(int, baliza.centro).s;
    const ladoSpawn = projetar(ext, spawn).lado;
    // Anel interno logo depois das vagas a 90° (curva de cima à direita).
    const sDepoisVagas = projetar(int, px(1300, 175)).s;
    // Trecho do meio-fio (faixa externa, lado esquerdo, sentido sul)
    const sMeioFioIni = projetar(ext, px(TRECHO_MEIO_FIO.x, TRECHO_MEIO_FIO.yIni)).s;
    const sMeioFioFim = projetar(ext, px(TRECHO_MEIO_FIO.x, TRECHO_MEIO_FIO.yFim)).s;

    const naFaixa = (f: Faixa, s: number, janela: number) => (c: Contexto) => {
      const pr = projetar(f, c.pos);
      if (pr.distancia > f.meiaLargura + PERTO_FAIXA) return false;
      if (Math.abs(deltaS(f, pr.s, s)) > janela) return false;
      if (pr.direcao.dot(c.frente) < 0.5) return false;
      // a outra faixa do anel não pode estar mais perto
      const outra = f === int ? ext : f === ext ? int : null;
      return !outra || projetar(outra, c.pos).distancia > pr.distancia;
    };
    const naAvenida = (c: Contexto) =>
      diagonais.some((f) => {
        const pr = projetar(f, c.pos);
        return pr.distancia < f.meiaLargura + PERTO_FAIXA && pr.s > 4 && pr.s < f.comprimento - 4 && pr.direcao.dot(c.frente) > 0.5;
      });
    /** Entrou na zona e saiu pela frente (+Z local = sentido do trânsito). */
    const passouPor = (z: Zona) => (c: Contexto) => {
      const dentro = dentroDaZona(z, c.pos);
      if (dentro) this.passouZona.set(z, true);
      if (dentro || !this.passouZona.get(z)) return false;
      const local = c.pos.clone().applyMatrix4(z.inversa);
      return local.z > z.max.z;
    };
    const eixoZona = (z: Zona) =>
      new THREE.Vector3().setFromMatrixColumn(new THREE.Matrix4().copy(z.inversa).invert(), 2).setY(0).normalize();
    const pontoExt = (s: number) => amostrar(ext, s).ponto;
    const pontoInt = (s: number) => amostrar(int, s).ponto;
    const parado = (c: Contexto) => Math.abs(c.v) < 0.05;

    const etapas: Etapa[] = [partida];

    // 1 ----------------------------------------------------------------------
    etapas.push({
      id: 'saida',
      texto: 'Ligue a seta à direita, saia da vaga e, no fim do estacionamento, vire à direita.',
      concluida: naFaixa(ext, sSpawnExt + 10, 8),
      // virou à esquerda: já está no anel interno, depois da passagem de nível — segue para a baliza
      errou: naFaixa(int, sSpawnInt + 10, 8),
      seErrar: 'baliza',
    });

    // 2 Rampa ----------------------------------------------------------------
    {
      let paradoT = 0;
      let parouEm: THREE.Vector3 | null = null;
      const eixo = eixoZona(rampa);
      const passou = passouPor(rampa);
      etapas.push({
        id: 'rampa',
        texto: 'Na subida à frente, pare o carro dentro da rampa. Depois siga em frente, sem deixar o carro voltar.',
        anunciarPerto: { ponto: rampa.centro, distancia: 45 },
        aoIniciar: () => {
          paradoT = 0;
          parouEm = null;
        },
        concluida: (c) => {
          if (!parouEm) {
            paradoT = parado(c) && dentroDaZona(rampa, c.pos) ? paradoT + c.dt : 0;
            if (paradoT > 1) {
              parouEm = c.pos.clone();
              this.mostrar('Muito bem. Agora siga em frente, sem deixar o carro voltar.');
            }
            return false;
          }
          return c.pos.clone().sub(parouEm).dot(eixo) > 4;
        },
        // passou pela subida sem parar
        errou: (c) => !parouEm && passou(c),
        seErrar: 'farol',
      });
    }

    // 3 Farol ----------------------------------------------------------------
    etapas.push({
      id: 'farol',
      texto: 'Acenda o farol baixo, por favor.',
      prazo: PRAZO_INSTRUCAO,
      // sem o estado do farol (main não passou), não dá para cobrar: segue depois de 2 s
      concluida: (c) => (c.cabine?.farol === undefined ? this.tempoNaEtapa > 2 : c.cabine.farol),
    });

    // 4 Semáforo de cima -----------------------------------------------------
    etapas.push({
      id: 'semaforo_cima',
      textoInicio: 'Siga pela pista.',
      texto: 'À frente tem semáforo: respeite o sinal e dê preferência aos pedestres.',
      anunciarPerto: { ponto: semCima.centro, distancia: 40 },
      concluida: passouPor(semCima),
    });

    // 5–7 Parada junto ao meio-fio + pisca-alerta ----------------------------
    let pontoParada: THREE.Vector3 | null = null;
    {
      let paradoDesde: number | null = null;
      let ultimaSetaAndando = -999;
      etapas.push({
        id: 'meio_fio',
        textoInicio: 'Siga pelo anel.',
        texto: 'Mais à frente, ligue a seta à direita e pare junto ao meio-fio, a no máximo cinquenta centímetros da calçada.',
        anunciarPerto: { ponto: pontoExt(sMeioFioIni), distancia: 40 },
        aoIniciar: () => {
          paradoDesde = null;
          ultimaSetaAndando = -999;
          pontoParada = null;
        },
        concluida: (c) => {
          if (Math.abs(c.v) > 0.2 && c.cabine?.seta === 'direita') ultimaSetaAndando = c.t;
          const pr = projetar(ext, c.pos);
          const noTrecho =
            deltaS(ext, pr.s, sMeioFioIni) > -3 &&
            deltaS(ext, pr.s, sMeioFioFim) < 3 &&
            pr.distancia < ext.meiaLargura + 1.5 &&
            projetar(int, c.pos).distancia > pr.distancia;
          if (!(noTrecho && parado(c))) {
            paradoDesde = null;
            return false;
          }
          paradoDesde ??= c.t;
          return c.t - paradoDesde > 1.5;
        },
        aoConcluir: (c) => {
          pontoParada = c.pos.clone();
          if (ultimaSetaAndando < (paradoDesde ?? c.t) - 10) prova.registrarFalta('parou_sem_seta');
          const d = this.afastamentoDireita();
          const txt = Number.isFinite(d) ? `${(d * 100).toFixed(0)} cm` : 'mais de 3 m';
          if (d > 1) {
            prova.registrarFalta('parou_afastado_meio_fio', {
              gravidade: 'media',
              descricao: `Parou afastado do meio-fio a mais de 1 m (${txt}, CTB art. 182, III)`,
            });
          } else if (d > AFASTAMENTO_MEIO_FIO) {
            prova.registrarFalta('parou_afastado_meio_fio', {
              descricao: `Parou afastado do meio-fio de 50 cm a 1 m (${txt}, CTB art. 182, II)`,
            });
          } else {
            prova.avisar(`Parada junto ao meio-fio: ${txt} da calçada`);
          }
        },
        // passou do trecho sem parar
        errou: naFaixa(ext, sMeioFioFim + 12, 6),
        seErrar: 'passagem_nivel_1',
      });
    }
    etapas.push({
      id: 'alerta',
      texto: 'Ligue o pisca-alerta.',
      prazo: PRAZO_INSTRUCAO,
      concluida: (c) => (c.cabine?.alerta === undefined ? this.tempoNaEtapa > 2 : c.cabine.alerta),
    });
    {
      let avaliou = false;
      etapas.push({
        id: 'retomar',
        texto: 'Desligue o pisca-alerta, ligue a seta à esquerda e retorne à pista.',
        aoIniciar: () => {
          avaliou = false;
        },
        concluida: (c) => {
          if (!avaliou && c.v > 0.3) {
            avaliou = true;
            if (prova.ultimaSeta('esquerda') < c.t - 6) {
              prova.registrarFalta('sem_seta', { descricao: 'Retomou a marcha sem sinalizar com a seta (CTB art. 196)' });
            }
          }
          return !pontoParada || dist2d(c.pos, pontoParada) > 6;
        },
      });
    }

    // 8–9 Passagem de nível e avenida ---------------------------------------
    etapas.push({
      id: 'passagem_nivel_1',
      textoInicio: 'Siga pela pista.',
      texto:
        'Atenção: passagem de nível à frente. Pare antes da linha férrea, olhe para os dois lados e só atravesse com a passagem livre. Depois dela, vire à esquerda e entre na avenida.',
      anunciarPerto: { ponto: pn1.centro, distancia: 40 },
      concluida: passouPor(pn1),
    });
    etapas.push({
      id: 'avenida',
      texto: 'Vire à esquerda e entre na avenida.',
      concluida: naAvenida,
      errou: naFaixa(ext, sEntradaExt + 22, 8), // passou direto
      seErrar: 'passagem_nivel_1', // mais uma volta pelo anel externo
    });
    etapas.push({
      id: 'semaforo_avenida',
      texto: 'Siga pela avenida e respeite o semáforo. No cruzamento, você vai virar à direita.',
      concluida: passouPor(semAvenida),
    });

    // 11–12 Vaga a 90° -------------------------------------------------------
    {
      let tentou = false;
      let dentroT = 0;
      let parcialT = 0;
      let motivo: 'esquerda' | 'passou' = 'passou';
      const virouEsquerda = naFaixa(ext, sFaixa1Ext + 18, 10);
      const passouVagas = naFaixa(int, sDepoisVagas, 6);
      etapas.push({
        id: 'vaga_90',
        texto:
          'Vire à direita e estacione em uma das vagas marcadas PARE, à direita. Pode entrar de frente ou de ré; o carro tem que ficar todo dentro da vaga.',
        prazo: TEMPO_VAGA_90,
        aoEstourar: () => {
          prova.registrarFalta('vaga_tempo');
          return 'Tempo esgotado. ';
        },
        aoIniciar: () => {
          tentou = false;
          dentroT = 0;
          parcialT = 0;
        },
        concluida: (c) => {
          const vaga = VAGAS_90.find((r) => dentroRet(r, c.pos, 1));
          if (!vaga) {
            dentroT = parcialT = 0;
            return false;
          }
          tentou = true;
          const inteiro = prova.geometria().cantos.every((k) => dentroRet(vaga, k, 0.05));
          dentroT = inteiro && parado(c) ? dentroT + c.dt : 0;
          parcialT = !inteiro && parado(c) && dentroRet(vaga, c.pos, 0.3) ? parcialT + c.dt : 0;
          if (dentroT > 2) {
            prova.avisar('Vaga a 90°: carro dentro da vaga');
            return true;
          }
          if (parcialT > 5) {
            prova.registrarFalta('vaga_fora');
            return true;
          }
          return false;
        },
        errou: (c) => {
          if (virouEsquerda(c)) {
            motivo = 'esquerda';
            return true;
          }
          motivo = 'passou';
          return !tentou && passouVagas(c);
        },
        // virou à esquerda: mais uma volta pelo externo (avenida de novo); passou direto: segue a volta
        seErrar: () => (motivo === 'esquerda' ? 'passagem_nivel_1' : 'passagem_nivel_2'),
      });
    }
    etapas.push({
      id: 'sair_vaga',
      texto: 'Muito bem. Ligue a seta, saia da vaga com cuidado e siga pela pista, à direita.',
      concluida: naFaixa(int, sDepoisVagas, 8),
      errou: naFaixa(ext, sFaixa1Ext + 18, 10), // saiu à esquerda
      seErrar: 'passagem_nivel_1',
    });

    // 13 Passagem de nível (sentido oeste) -----------------------------------
    etapas.push({
      id: 'passagem_nivel_2',
      textoInicio: 'Siga pelo anel.',
      texto: 'Passagem de nível à frente: pare antes da linha férrea, olhe para os dois lados e só atravesse com a passagem livre.',
      anunciarPerto: { ponto: pn2.centro, distancia: 40 },
      concluida: passouPor(pn2),
    });

    // 14–15 Baliza -----------------------------------------------------------
    etapas.push({
      id: 'baliza',
      textoInicio: 'Siga pelo anel.',
      texto: 'Faça a baliza na vaga à direita.',
      anunciarPerto: { ponto: baliza.centro, distancia: 35 },
      concluida: () => prova.balizaConcluida !== null || prova.faltas.some((f) => f.codigo === 'baliza_tempo'),
      errou: (c) => prova.balizaInicio === null && naFaixa(int, sBalizaInt + 25, 8)(c),
    });
    etapas.push({
      id: 'sair_baliza',
      texto: 'Muito bem. Ligue a seta, saia da vaga e siga em frente.',
      concluida: naFaixa(int, sBalizaInt + 22, 10),
    });

    // 16 Semáforo da esquerda ------------------------------------------------
    etapas.push({
      id: 'semaforo_esquerda',
      textoInicio: 'Siga pelo anel.',
      texto: 'À frente tem semáforo: respeite o sinal e dê preferência aos pedestres.',
      anunciarPerto: { ponto: semEsquerda.centro, distancia: 40 },
      concluida: passouPor(semEsquerda),
    });

    // 17 Entrar no estacionamento --------------------------------------------
    etapas.push({
      id: 'estacionamento',
      textoInicio: 'Siga pelo anel.',
      texto: 'Na próxima, vire à esquerda e entre no estacionamento.',
      anunciarPerto: { ponto: pontoInt(sSpawnInt), distancia: 40 },
      concluida: (c) => {
        const pr = projetar(ext, c.pos);
        return pr.lado === ladoSpawn && pr.distancia > ext.meiaLargura + 1 && dist2d(c.pos, spawn) < 15;
      },
      errou: naFaixa(int, sSpawnInt + 22, 8),
      seErrar: 'semaforo_esquerda', // mais uma volta pelo anel interno
    });

    // 18 Meia-volta ------------------------------------------------------------
    {
      let rumoAnt: number | null = null;
      let giro = 0;
      let usouRe = false;
      etapas.push({
        id: 'meia_volta',
        texto:
          'Agora faça a meia-volta aqui no estacionamento, em três movimentos, usando a marcha à ré e sem subir no meio-fio.',
        manobra: true,
        prazo: TEMPO_MEIA_VOLTA,
        aoIniciar: () => {
          rumoAnt = null;
          giro = 0;
          usouRe = false;
        },
        concluida: (c) => {
          const rumo = Math.atan2(c.frente.x, c.frente.z);
          if (rumoAnt !== null) giro += angulo(rumo - rumoAnt);
          rumoAnt = rumo;
          if (c.re || c.v < -0.3) usouRe = true;
          if (Math.abs(giro) < (150 * Math.PI) / 180) return false;
          if (!usouRe) {
            prova.registrarFalta('nao_seguiu_instrucao', {
              descricao: 'Fez a meia-volta sem os três movimentos (não usou a marcha à ré)',
            });
          } else {
            prova.avisar('Meia-volta concluída');
          }
          return true;
        },
        // saiu do estacionamento sem completar
        errou: (c) => !dentroRet(ESTACIONAMENTO, c.pos, 2.5),
        seErrar: 'estacionar',
      });
    }

    // 19 Estacionar e encerrar ------------------------------------------------
    {
      let paradoNaVaga = 0;
      etapas.push({
        id: 'estacionar',
        texto: 'Muito bem. Agora estacione de ré na vaga de onde saiu, puxe o freio de mão e aguarde.',
        manobra: true,
        prazo: TEMPO_MEIA_VOLTA,
        aoEstourar: () => {
          prova.registrarFalta('nao_seguiu_instrucao', { descricao: 'Não estacionou na vaga no tempo' });
          this.finalizar();
          return '';
        },
        aoIniciar: () => {
          paradoNaVaga = 0;
        },
        concluida: (c) => {
          const ok = dist2d(c.pos, spawn) < 3.5 && parado(c);
          paradoNaVaga = ok ? paradoNaVaga + c.dt : 0;
          return paradoNaVaga > 2;
        },
        aoConcluir: () => this.finalizar(),
      });
    }
    return etapas;
  }

  /**
   * Distância (m) do lado direito da carroceria até a calçada: o maior dos dois cantos
   * (dianteiro e traseiro), medido na perpendicular ao carro. Infinity se não achar até 3 m.
   */
  private afastamentoDireita(): number {
    const g = this.prova.geometria();
    const direita = new THREE.Vector3(-g.frente.z, 0, g.frente.x);
    return Math.max(distanciaCalcada(g.cantos[1], direita, 3), distanciaCalcada(g.cantos[3], direita, 3));
  }
}

function angulo(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function dist2d(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function falador(): SpeechSynthesis | null {
  return typeof globalThis !== 'undefined' && 'speechSynthesis' in globalThis
    ? (globalThis as unknown as { speechSynthesis: SpeechSynthesis }).speechSynthesis
    : null;
}
