import type { Acao, AcaoBotao, EstadoEntrada } from '../input/input';
import { poseCarro, PoseCarro } from './geo';
import { DefLicao, Exec, Memoria, Passo, texto } from './passo';
import type { ContextoTreino, IdLicao, InfoPasso, Licao, Marcador, TipoMensagem } from './tipos';
import { LICAO_CONHECER } from './licoes/conhecerCarro';
import { LICAO_SAIR } from './licoes/sairTrocarParar';
import { LICAO_PLACAS } from './licoes/placas';
import { LICAO_RAMPA } from './licoes/rampa';
import { LICAO_BALIZA } from './licoes/baliza';

export type { AlvoCamera, ContextoTreino, IdLicao, InfoPasso, Licao, Marcador } from './tipos';

/**
 * Treino guiado: lições curtas, cada uma uma lista de passos pequenos. Cada passo tem
 * um detector que avança sozinho quando o aluno faz o que foi pedido, dica se ele
 * travar (~15 s), voz + texto, e um "Muito bem!" entre os passos.
 *
 * Sem DOM / canvas / voz aqui: tudo vai pelo ContextoTreino (main.ts) e pela UI
 * (render/treinoUi.ts). Chame `atualizar(dt)` uma vez por quadro, DEPOIS da física.
 */

const DEFS: Record<IdLicao, DefLicao> = {
  conhecer_carro: LICAO_CONHECER,
  sair_trocar_parar: LICAO_SAIR,
  placas: LICAO_PLACAS,
  rampa: LICAO_RAMPA,
  baliza: LICAO_BALIZA,
};

export const LICOES: Licao[] = (Object.keys(DEFS) as IdLicao[]).map((id) => ({
  id,
  titulo: DEFS[id].titulo,
  descricao: DEFS[id].descricao,
  passos: DEFS[id].passos.length,
}));

/** Depois de quanto tempo parado num passo a dica aparece (s). */
export const TEMPO_DICA = 15;
const DURACAO_FESTA = 1.6;
const FESTAS = ['Muito bem!', 'Isso!', 'Ótimo!', 'Perfeito!', 'Mandou bem!', 'Excelente!'];

type Fase = 'passo' | 'festa' | 'recuperacao' | 'falha' | 'quizResposta' | 'fim';

interface Amostra {
  t: number;
  emb: number;
  freio: number;
  v: number;
  marcha: number;
  freioDeMao: boolean;
  rpm: number;
}

const ENTRADA_VAZIA: EstadoEntrada = {
  volante: 0, acelerador: 0, freio: 0, embreagem: 0, marcha: 0, freioDeMao: true,
  partida: false, partidaBorda: false, seta: null, cinto: false, farol: false, alerta: false,
  olhar: 0, olharTras: false, bordas: new Set(), temVolante: false,
};

export class Treino {
  private readonly ctx: ContextoTreino;
  private def: DefLicao | null = null;
  private indice = 0;
  /** Muda a cada cartão novo: falas de um cartão antigo são descartadas (ver main.ts). */
  geracao = 0;
  private fase: Fase = 'passo';
  private tFase = 0;
  private tPasso = 0;
  private mem: Memoria = {};
  private licaoMem: Memoria = {};
  private ent: EstadoEntrada = ENTRADA_VAZIA;
  private dtAtual = 0;
  private poseCache: PoseCarro | null = null;
  private dicaMostrada = false;
  private mensagem: { texto: string; tipo: TipoMensagem; ate: number } | null = null;
  private relogio = 0;
  private nFesta = 0;
  private recuperacao: { motivo: string; voltarPara: number } | null = null;
  private falha: { motivo: string; irPara: number } | null = null;
  private quizEscolhida: number | null = null;
  private ligadoAntes = false;
  private historico: Amostra[] = [];
  private pedidoIrPara: string | null = null;
  private readonly exec: Exec;

  constructor(ctx: ContextoTreino) {
    this.ctx = ctx;
    const self = this;
    this.exec = {
      ctx,
      get sim() { return ctx.sim; },
      get trem() { return ctx.sim.carro.trem; },
      get ent() { return self.ent; },
      get dt() { return self.dtAtual; },
      get t() { return self.tPasso; },
      get mem() { return self.mem; },
      get licao() { return self.licaoMem; },
      get dispositivo() { return ctx.perfilControles().dispositivo; },
      nome: (a: Acao) => ctx.perfilControles().nomeDe(a),
      pose: () => (this.poseCache ??= poseCarro(ctx.sim)),
      kmh: () => Math.abs(ctx.sim.carro.velocidadeLongitudinal()) * 3.6,
      irPara: (id: string) => { this.pedidoIrPara = id; },
      avisar: (t: string, tipo: TipoMensagem = 'info', falar = false) => this.avisar(t, tipo, falar),
      falar: (t: string) => this.ctx.falar(t),
      teleportar: (x: number, y: number, yaw: number) => {
        this.ctx.teleportar(x, y, yaw);
        this.poseCache = null;
        this.ligadoAntes = false;
        this.historico = [];
      },
    };
  }

  // ------------------------------------------------------------------ API pública

  get ativa(): IdLicao | null {
    return this.def?.id ?? null;
  }

  get concluida(): boolean {
    return this.fase === 'fim';
  }

  /** Lição em andamento (para a UI). */
  get licao(): Licao | null {
    return this.def ? LICOES.find((l) => l.id === this.def!.id) ?? null : null;
  }

  get passoAtual(): InfoPasso | null {
    const def = this.def;
    if (!def) return null;
    const total = def.passos.length;
    const msg = this.mensagem && this.mensagem.ate > this.relogio ? { texto: this.mensagem.texto, tipo: this.mensagem.tipo } : undefined;
    if (this.fase === 'fim') {
      return {
        id: 'fim', tipo: 'fim', indice: total, total, celebrando: true,
        titulo: 'Lição concluída!',
        texto: def.resumo?.(this.exec) ?? 'Você terminou esta lição. Pode repetir quando quiser ou escolher outra no menu.',
        progresso: 1, mensagem: msg,
      };
    }
    const p = def.passos[this.indice];
    const x = this.exec;
    if (this.fase === 'recuperacao' && this.recuperacao) {
      return {
        id: 'motor_apagou', tipo: 'acao', indice: this.indice, total, celebrando: false,
        titulo: 'O motor apagou',
        texto: `${this.recuperacao.motivo} Pise a embreagem até o fundo, coloque em neutro e dê a partida de novo (${x.nome('partida')}).`,
        dica: this.tPasso > TEMPO_DICA ? 'Com a embreagem no fundo e o câmbio em neutro, segure o botão de partida até o motor pegar.' : undefined,
        mensagem: msg,
      };
    }
    if (this.fase === 'falha' && this.falha) {
      return {
        id: `${p.id}_falhou`, tipo: 'acao', indice: this.indice, total, celebrando: false,
        titulo: 'Vamos tentar de novo', texto: this.falha.motivo, mensagem: msg ?? { texto: this.falha.motivo, tipo: 'erro' },
      };
    }
    const info: InfoPasso = {
      id: p.id,
      tipo: p.quiz ? 'quiz' : p.leitura ? 'leitura' : 'acao',
      indice: this.indice,
      total,
      titulo: p.titulo,
      texto: texto(p.texto, x) ?? '',
      dica: this.dicaMostrada ? texto(p.dica, x) : undefined,
      progresso: this.fase === 'festa' ? 1 : p.progresso?.(x),
      rotuloProgresso: p.rotuloProgresso,
      faixaBoa: p.faixaBoa,
      celebrando: this.fase === 'festa',
      mensagem: msg,
    };
    if (p.leitura && this.fase === 'passo' && info.progresso === undefined) info.progresso = Math.min(1, this.tPasso / this.duracaoLeitura(p));
    if (p.quiz) {
      info.quiz = {
        pergunta: p.quiz.pergunta,
        opcoes: p.quiz.opcoes,
        escolhida: this.quizEscolhida,
        correta: this.quizEscolhida !== null ? p.quiz.correta : null,
        teclas: this.teclasQuiz().map((a) => x.nome(a)),
      };
    }
    return info;
  }

  /** Marcadores de referência no chão (baliza etc.). */
  get marcadores(): Marcador[] {
    const def = this.def;
    if (!def || this.fase === 'fim') return [];
    const p = def.passos[this.indice];
    return p.marcadores?.(this.exec) ?? def.marcadores?.(this.exec) ?? [];
  }

  iniciar(id: IdLicao): void {
    this.def = DEFS[id];
    this.licaoMem = {};
    this.mensagem = null;
    this.historico = [];
    this.ligadoAntes = this.ctx.sim.carro.trem.ligado;
    this.def.aoIniciar?.(this.exec);
    this.irParaIndice(0);
  }

  atualizar(dt: number): void {
    const def = this.def;
    if (!def) return;
    this.dtAtual = dt;
    this.relogio += dt;
    this.ent = this.ctx.entrada();
    this.poseCache = null;
    this.tFase += dt;
    this.tPasso += dt;
    const trem = this.ctx.sim.carro.trem;
    const x = this.exec;

    // histórico curto (para explicar por que o motor apagou)
    const v = this.ctx.sim.carro.velocidadeLongitudinal();
    this.historico.push({ t: this.relogio, emb: this.ent.embreagem, freio: this.ent.freio, v, marcha: trem.marchaEngatada, freioDeMao: this.ent.freioDeMao, rpm: trem.rpm });
    while (this.historico.length && this.historico[0].t < this.relogio - 2) this.historico.shift();
    const apagou = this.ligadoAntes && !trem.ligado && !this.ent.partidaBorda;
    this.ligadoAntes = trem.ligado;

    if (this.fase === 'fim') return;
    const p = def.passos[this.indice];

    switch (this.fase) {
      case 'festa':
        if (this.tFase >= DURACAO_FESTA) this.irParaIndice(this.indice + 1);
        return;
      case 'quizResposta': {
        const certo = this.quizEscolhida === p.quiz?.correta;
        if (this.tFase >= (certo ? 3 : 6)) this.irParaIndice(this.indice + 1);
        return;
      }
      case 'falha':
        if (this.tFase >= 3.5 && this.falha) {
          const destino = this.falha.irPara;
          this.falha = null;
          this.irParaIndice(destino);
        }
        return;
      case 'recuperacao':
        if (this.recuperacao && trem.ligado) {
          const volta = this.recuperacao.voltarPara;
          this.recuperacao = null;
          this.avisar('Motor ligado de novo. Vamos continuar!', 'sucesso', true);
          this.irParaIndice(volta);
        } else if (this.tPasso > TEMPO_DICA && !this.dicaMostrada) {
          this.dicaMostrada = true;
        }
        return;
      case 'passo':
        break;
    }

    // --- passo em andamento
    const motivoFalha = p.falhou?.(x) ?? null;
    if (motivoFalha) {
      const destino = this.indicePorId(p.seFalhar ?? p.id);
      this.falha = { motivo: motivoFalha, irPara: destino };
      this.fase = 'falha';
      this.tFase = 0;
      this.avisar(motivoFalha, 'erro', true);
      return;
    }
    if (p.requerMotor && apagou) {
      const motivo = this.motivoApagou();
      this.recuperacao = { motivo, voltarPara: this.indicePorId(p.aoApagar ?? p.id) };
      this.fase = 'recuperacao';
      this.tFase = 0;
      this.tPasso = 0;
      this.dicaMostrada = false;
      this.ctx.focarCamera(null);
      this.ctx.falar(`O motor apagou. ${motivo}`);
      return;
    }

    if (p.quiz) {
      const teclas = this.teclasQuiz();
      teclas.forEach((a, i) => {
        if (this.ent.bordas.has(a) && i < p.quiz!.opcoes.length) this.responder(i);
      });
      if (this.fase !== 'passo') return;
    }

    let feito = false;
    if (p.leitura) feito = this.tPasso >= this.duracaoLeitura(p) || (p.detectar?.(x) ?? false);
    else if (p.detectar) feito = p.detectar(x);

    if (this.pedidoIrPara) {
      const id = this.pedidoIrPara;
      this.pedidoIrPara = null;
      this.irParaIndice(this.indicePorId(id));
      return;
    }

    if (feito) {
      this.concluirPasso(p);
      return;
    }
    if (!this.dicaMostrada && p.dica && this.tPasso > TEMPO_DICA) {
      this.dicaMostrada = true;
      const d = texto(p.dica, x);
      if (d) this.ctx.falar(d, 'cartao');
    }
  }

  /** Responde à pergunta do passo atual (0, 1, 2…). */
  responder(i: number): void {
    const p = this.def?.passos[this.indice];
    if (!p?.quiz || this.fase !== 'passo' || this.quizEscolhida !== null) return;
    this.quizEscolhida = i;
    const certo = i === p.quiz.correta;
    this.licaoMem.acertos = (this.licaoMem.acertos ?? 0) + (certo ? 1 : 0);
    this.licaoMem.perguntas = (this.licaoMem.perguntas ?? 0) + 1;
    const frase = certo ? `Isso mesmo! ${p.quiz.explicacao}` : `Não é bem isso. ${p.quiz.explicacao}`;
    this.avisar(frase, certo ? 'sucesso' : 'erro', true);
    this.fase = 'quizResposta';
    this.tFase = 0;
  }

  /** Passo de explicação: vai para o próximo sem esperar. */
  continuar(): void {
    const p = this.def?.passos[this.indice];
    if (!p) return;
    if (this.fase === 'festa' || this.fase === 'quizResposta') this.irParaIndice(this.indice + 1);
    else if (this.fase === 'passo' && p.leitura) this.concluirPasso(p);
  }

  pular(): void {
    if (!this.def || this.fase === 'fim') return;
    this.recuperacao = null;
    this.falha = null;
    this.irParaIndice(this.indice + 1);
  }

  repetir(): void {
    if (!this.def) return;
    if (this.fase === 'fim') {
      this.iniciar(this.def.id);
      return;
    }
    const p = this.def.passos[this.indice];
    this.recuperacao = null;
    this.falha = null;
    this.irParaIndice(this.indicePorId(p.repetirDe ?? p.id));
  }

  sair(): void {
    this.geracao++;
    this.def = null;
    this.fase = 'passo';
    this.mensagem = null;
    this.recuperacao = null;
    this.falha = null;
    this.ctx.focarCamera(null);
  }

  // ------------------------------------------------------------------ interno

  private avisar(t: string, tipo: TipoMensagem, falar: boolean): void {
    this.mensagem = { texto: t, tipo, ate: this.relogio + Math.max(3, t.split(/\s+/).length / 2.6 + 1.5) };
    if (falar) this.ctx.falar(t);
  }

  private teclasQuiz(): AcaoBotao[] {
    return this.exec.dispositivo === 'controle' ? ['setaEsq', 'farol', 'setaDir'] : ['marcha1', 'marcha2', 'marcha3'];
  }

  private duracaoLeitura(p: Passo): number {
    if (typeof p.leitura === 'number') return p.leitura;
    const palavras = (texto(p.texto, this.exec) ?? '').split(/\s+/).length;
    return Math.max(5, palavras / 2.4 + 2.5);
  }

  private indicePorId(id: string): number {
    const i = this.def?.passos.findIndex((p) => p.id === id) ?? -1;
    return i < 0 ? this.indice : i;
  }

  private concluirPasso(p: Passo): void {
    const rapido = this.tPasso < 0.4; // já estava feito ao chegar no passo
    if (p.semFesta || p.leitura || rapido) {
      this.irParaIndice(this.indice + 1);
      return;
    }
    const frase = p.festa ?? FESTAS[this.nFesta++ % FESTAS.length];
    this.avisar(frase, 'sucesso', true);
    this.fase = 'festa';
    this.tFase = 0;
  }

  private irParaIndice(i: number): void {
    const def = this.def;
    if (!def) return;
    this.geracao++;
    this.fase = 'passo';
    this.tFase = 0;
    this.tPasso = 0;
    this.mem = {};
    this.dicaMostrada = false;
    this.quizEscolhida = null;
    this.pedidoIrPara = null;
    if (i >= def.passos.length) {
      this.indice = def.passos.length - 1;
      this.fase = 'fim';
      this.ctx.focarCamera(null);
      const r = def.resumo?.(this.exec);
      this.ctx.falar(`Lição concluída! ${r ?? ''}`.trim());
      return;
    }
    this.indice = Math.max(0, i);
    const p = def.passos[this.indice];
    this.ctx.focarCamera(p.foco ?? null);
    p.aoIniciar?.(this.exec);
    if (this.pedidoIrPara) {
      const id = this.pedidoIrPara;
      this.pedidoIrPara = null;
      this.irParaIndice(this.indicePorId(id));
      return;
    }
    // passo que precisa do motor, mas ele morreu durante o "Muito bem!" (ou já estava desligado)
    if (p.requerMotor && !this.ctx.sim.carro.trem.ligado) {
      const motivo = this.historico.some((a) => a.rpm > 300) ? this.motivoApagou() : 'O motor está desligado.';
      this.recuperacao = { motivo, voltarPara: this.indicePorId(p.aoApagar ?? p.id) };
      this.fase = 'recuperacao';
      this.ctx.focarCamera(null);
      this.ctx.falar(`${motivo} Dê a partida de novo.`);
      return;
    }
    const falado = texto(p.texto, this.exec);
    if (falado) this.ctx.falar(p.quiz ? `${falado} ${p.quiz.pergunta}` : falado, 'cartao');
  }

  /** Explica, pelo que aconteceu nos últimos ~2 s, por que o motor apagou. */
  private motivoApagou(): string {
    const h = this.historico;
    if (!h.length) return 'O giro do motor caiu demais.';
    const ult = h[h.length - 1];
    const recente = h.filter((a) => a.t > ult.t - 0.8);
    const embMax = Math.max(...recente.map((a) => a.emb));
    const freou = recente.some((a) => a.freio > 0.25);
    const vMax = Math.max(...h.map((a) => Math.abs(a.v)));
    const marcha = h.find((a) => a.marcha !== 0)?.marcha ?? ult.marcha;
    if (freou && ult.emb < 0.6 && vMax > 1) {
      return 'Você freou até quase parar sem pisar na embreagem. Antes do carro parar, pise a embreagem até o fundo.';
    }
    if (ult.freioDeMao && marcha !== 0 && Math.abs(ult.v) < 0.5) {
      return 'O freio de mão estava puxado e a embreagem passou do ponto. Solte o freio de mão no ponto da embreagem, antes de soltar o resto do pedal.';
    }
    if (marcha >= 2 && vMax < 3) {
      return `A ${marcha}ª marcha é forte demais para sair ou andar tão devagar. Use a 1ª para sair.`;
    }
    if (embMax - ult.emb > 0.25 && Math.abs(ult.v) < 2) {
      return 'Você soltou a embreagem rápido demais. No ponto, segure o pedal um instante e solte bem devagar, com um pouquinho de acelerador.';
    }
    return 'O giro do motor caiu demais para a marcha engatada. Acelere um pouco mais ou pise a embreagem quando o carro estiver quase parando.';
  }
}
