import * as THREE from 'three';
import type { Simulacao } from '../sim/simulation';
import { dentroDaZona, Zona } from '../world/parser';
import { amostrar, Faixa, projetar } from '../world/vias';
import type { Prova } from './exam';
import { deltaS } from './pista';

/**
 * Examinador da autoescola: dá as instruções do trajeto (voz + texto), confere se o
 * candidato chegou a cada ponto e marca "não seguiu a instrução" quando ele erra o caminho.
 *
 * Trajeto (pontos calculados a partir de vias.ts e das zonas do mapa):
 *   0  cinto + partida
 *   1  sair da vaga à direita → anel externo (sentido anti-horário)
 *   2  PARE de cima (ZONA_PARE_2), faixas de pedestres
 *   3  descer pelo lado esquerdo do anel externo
 *   4  embaixo: virar à esquerda e entrar na avenida (diagonal)
 *   5  subir a avenida e parar no PARE (ZONA_PARE_1)
 *   6  virar à direita → anel interno (sentido horário)
 *   7  baliza (vaga à direita, lado esquerdo do mapa)
 *   8  sair da baliza
 *   9  dar a volta e entrar à esquerda no estacionamento
 *  10  parar na vaga → encerra a prova
 *
 * Errando o caminho, o examinador marca a falta e manda o candidato para a etapa que
 * faz sentido de onde ele está (o anel é fechado: perder uma entrada = dar mais uma volta).
 */
export interface OpcoesExaminador {
  voz?: boolean;
  volumeVoz?: number;
}

interface Contexto {
  pos: THREE.Vector3;
  frente: THREE.Vector3;
  v: number;
  dt: number;
}

interface Etapa {
  /** Falado assim que a etapa começa (opcional). */
  textoInicio?: string;
  /** Instrução principal. Sem `anunciarPerto`, é falada no início. */
  texto: string;
  /** Fala `texto` quando o carro chega a esta distância (m, em linha reta) do ponto. */
  anunciarPerto?: { ponto: THREE.Vector3; distancia: number };
  concluida: (c: Contexto) => boolean;
  /** Errou o caminho? */
  errou?: (c: Contexto) => boolean;
  /** Para onde ir quando errar (índice de etapa). Padrão: repete esta. */
  seErrar?: number;
  aoConcluir?: () => void;
}

const PERTO_FAIXA = 0.8; // folga lateral para "está nesta faixa" (m)

export class Examinador {
  private readonly sim: Simulacao;
  private prova: Prova;
  private readonly etapas: Etapa[];
  private indice = 0;
  private anunciado = false;
  private texto: string | null = null;
  private tempoNaEtapa = 0;
  private tempoErro = 0;
  private paradoNaVaga = 0;
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
    this.prepararVoz();
  }

  get instrucao(): string | null {
    return this.texto;
  }
  get etapa(): number {
    return Math.min(this.indice, this.etapas.length);
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
    this.indice = 0;
    this.anunciado = false;
    this.texto = null;
    this.tempoNaEtapa = 0;
    this.tempoErro = 0;
    this.paradoNaVaga = 0;
    this.inicioFalado = false;
    this.passouZona.clear();
    this.terminou = false;
    falador()?.cancel();
  }

  atualizar(dt: number): void {
    if (this.terminou) return;
    if (this.prova.encerrada) {
      this.terminou = true;
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
    }

    if (etapa.concluida(c)) {
      etapa.aoConcluir?.();
      this.irPara(this.indice + 1);
      return;
    }

    if (etapa.errou && this.prova.iniciada) {
      if (etapa.errou(c)) {
        this.tempoErro += dt;
        if (this.tempoErro > 0.8) {
          this.prova.registrarFalta('nao_seguiu_instrucao');
          const destino = etapa.seErrar ?? this.indice;
          this.irPara(destino, 'Você não seguiu a instrução. ');
        }
      } else this.tempoErro = 0;
    }
  }

  // ---------------------------------------------------------------------------

  private irPara(i: number, prefixo = ''): void {
    this.indice = i;
    this.anunciado = false;
    this.tempoNaEtapa = 0;
    this.tempoErro = 0;
    this.inicioFalado = false;
    this.passouZona.clear();
    const e = this.etapas[i];
    if (!e) {
      this.terminou = true;
      return;
    }
    if (prefixo) {
      // Avisa o erro junto com o que fazer agora.
      const agora = e.anunciarPerto ? (e.textoInicio ?? 'Siga pela pista.') : e.texto;
      this.mostrar(prefixo + agora);
      this.inicioFalado = true;
      if (!e.anunciarPerto) this.anunciado = true;
    }
  }

  private contexto(dt: number): Contexto {
    const corpo = this.sim.carro.corpo;
    const t = corpo.translation();
    const r = corpo.rotation();
    const frente = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    frente.y = 0;
    frente.normalize();
    return { pos: new THREE.Vector3(t.x, 0, t.z), frente, v: this.sim.carro.velocidadeLongitudinal(), dt };
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

  // ---------------------------------------------------------------------------
  // Trajeto

  private montarTrajeto(): Etapa[] {
    const mapa = this.sim.mapa;
    const pista = this.prova.pista;
    const int = pista.interno;
    const ext = pista.externo;
    const diagonais = pista.faixas.filter((f) => f.id.startsWith('diagonal'));
    const zona = (nome: string) => mapa.zonas.find((z) => z.nome.toUpperCase() === nome);
    const pare1 = zona('ZONA_PARE_1');
    const pare2 = zona('ZONA_PARE_2');
    const faixaPed1 = zona('FAIXA_PEDESTRE_1');
    const baliza = mapa.zonas.find((z) => z.tipo === 'baliza');
    const spawn = mapa.spawn.posicao.clone().setY(0);

    const partida: Etapa = {
      texto: 'Coloque o cinto de segurança e dê a partida.',
      concluida: () => this.prova.iniciada,
    };

    // Fora da autoescola (mapa de teste): só partida e encerrar quando o candidato quiser.
    if (!int || !ext || !diagonais.length || !pare1 || !pare2 || !baliza) {
      return [
        partida,
        { texto: 'Siga pela pista. Encerre a prova quando terminar.', concluida: () => false },
      ];
    }

    const diag = diagonais[Math.floor(diagonais.length / 2)];
    const sSpawnExt = projetar(ext, spawn).s;
    const sSpawnInt = projetar(int, spawn).s;
    const sEntradaExt = projetar(ext, diag.pontos[0]).s;
    const sFaixa1Ext = faixaPed1 ? projetar(ext, faixaPed1.centro).s : projetar(ext, pare2.centro).s + 15;
    const sBalizaInt = projetar(int, baliza.centro).s;
    const sBalizaExt = projetar(ext, baliza.centro).s;
    const ladoSpawn = projetar(ext, spawn).lado;
    // Lado direito do anel interno (ponto mais a leste): confirma que virou à direita no fim da avenida.
    const iLeste = int.pontos.reduce((m, p, i) => (p.x > int.pontos[m].x ? i : m), 0);
    const sDireitaInt = int.acumulado[iLeste];

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
    const pontoExt = (s: number) => amostrar(ext, s).ponto;
    const pontoInt = (s: number) => amostrar(int, s).ponto;

    const etapas: Etapa[] = [];
    etapas.push(partida); // 0
    etapas.push({
      // 1
      texto: 'Ligue a seta, saia da vaga e siga à direita.',
      concluida: naFaixa(ext, sSpawnExt + 10, 8),
      errou: naFaixa(int, sSpawnInt + 10, 8), // virou à esquerda
      seErrar: 7, // do anel interno o caminho natural é a baliza
    });
    etapas.push({
      // 2
      textoInicio: 'Siga pela pista.',
      texto: 'À frente, pare na placa PARE e dê preferência aos pedestres.',
      anunciarPerto: { ponto: pare2.centro, distancia: 40 },
      concluida: passouPor(pare2),
    });
    etapas.push({
      // 3
      texto: 'Siga em frente pelo anel.',
      concluida: naFaixa(ext, sBalizaExt, 12),
    });
    etapas.push({
      // 4
      texto: 'Na próxima, vire à esquerda e entre na avenida.',
      anunciarPerto: { ponto: pontoExt(sEntradaExt), distancia: 40 },
      concluida: naAvenida,
      errou: naFaixa(ext, sEntradaExt + 22, 8), // passou direto
      seErrar: 2, // mais uma volta pelo anel externo
    });
    etapas.push({
      // 5
      texto: 'Siga pela avenida e pare na placa PARE.',
      concluida: passouPor(pare1),
    });
    etapas.push({
      // 6
      texto: 'Vire à direita.',
      concluida: naFaixa(int, sDireitaInt, 15),
      errou: naFaixa(ext, sFaixa1Ext + 18, 10), // virou à esquerda
      seErrar: 3,
    });
    etapas.push({
      // 7
      textoInicio: 'Siga pelo anel.',
      texto: 'Faça a baliza na vaga à direita.',
      anunciarPerto: { ponto: baliza.centro, distancia: 32 },
      concluida: () =>
        this.prova.balizaConcluida !== null || this.prova.faltas.some((f) => f.codigo === 'baliza_tempo'),
      errou: (c) => this.prova.balizaInicio === null && naFaixa(int, sBalizaInt + 25, 8)(c),
    });
    etapas.push({
      // 8
      texto: 'Muito bem. Ligue a seta, saia da vaga e siga em frente.',
      concluida: naFaixa(int, sBalizaInt + 22, 10),
    });
    etapas.push({
      // 9
      textoInicio: 'Siga pelo anel.',
      texto: 'Na próxima, vire à esquerda e entre no estacionamento.',
      anunciarPerto: { ponto: pontoInt(sSpawnInt), distancia: 30 },
      concluida: (c) => {
        const pr = projetar(ext, c.pos);
        return pr.lado === ladoSpawn && pr.distancia > ext.meiaLargura + 1 && dist2d(c.pos, spawn) < 15;
      },
      errou: naFaixa(int, sSpawnInt + 22, 8),
    });
    etapas.push({
      // 10
      texto: 'Estacione na vaga de onde saiu, puxe o freio de mão e aguarde.',
      concluida: (c) => {
        const ok = dist2d(c.pos, spawn) < 3.5 && Math.abs(c.v) < 0.1;
        this.paradoNaVaga = ok ? this.paradoNaVaga + c.dt : 0;
        return this.paradoNaVaga > 2;
      },
      aoConcluir: () => {
        this.prova.encerrar();
        this.mostrar(this.prova.aprovado ? 'Prova encerrada. Parabéns, você foi aprovado!' : 'Prova encerrada. Infelizmente, você foi reprovado.');
      },
    });
    return etapas;
  }
}

function dist2d(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function falador(): SpeechSynthesis | null {
  return typeof globalThis !== 'undefined' && 'speechSynthesis' in globalThis
    ? (globalThis as unknown as { speechSynthesis: SpeechSynthesis }).speechSynthesis
    : null;
}
