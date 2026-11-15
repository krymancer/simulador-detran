import type { Acao, EstadoEntrada } from '../input/input';
import type { Simulacao } from '../sim/simulation';
import type { TremDeForca } from '../sim/powertrain';
import type { PoseCarro } from './geo';
import type { AlvoCamera, ContextoTreino, Dispositivo, IdLicao, Marcador, Quiz, TipoMensagem } from './tipos';

export type Memoria = Record<string, any>;

/** O que um passo enxerga a cada quadro. */
export interface Exec {
  readonly ctx: ContextoTreino;
  readonly sim: Simulacao;
  readonly trem: TremDeForca;
  /** Entrada deste quadro. */
  readonly ent: EstadoEntrada;
  readonly dt: number;
  /** Segundos desde que o passo começou. */
  readonly t: number;
  /** Memória do passo (zerada a cada início do passo). */
  readonly mem: Memoria;
  /** Memória da lição (zerada ao iniciar a lição). */
  readonly licao: Memoria;
  readonly dispositivo: Dispositivo;
  /** Nome do comando físico desta ação no dispositivo ativo ("Pedal da esquerda", "Tecla I"…). */
  nome(acao: Acao): string;
  pose(): PoseCarro;
  /** |velocidade| em km/h */
  kmh(): number;
  irPara(id: string): void;
  avisar(texto: string, tipo?: TipoMensagem, falar?: boolean): void;
  falar(texto: string): void;
  teleportar(pxX: number, pxY: number, yaw: number): void;
}

export type Texto = string | ((x: Exec) => string);

export interface Passo {
  id: string;
  titulo: string;
  texto: Texto;
  /** Mostrada (e falada) se o aluno ficar parado no passo por mais de ~15 s. */
  dica?: Texto;
  foco?: AlvoCamera;
  /** Passo de explicação: avança sozinho depois de N s (true = pelo tamanho do texto) ou no "Continuar". */
  leitura?: true | number;
  quiz?: Quiz;
  aoIniciar?: (x: Exec) => void;
  /** Verdadeiro quando o aluno fez o que foi pedido. */
  detectar?: (x: Exec) => boolean;
  /** 0..1 (medidor no painel). */
  progresso?: (x: Exec) => number | undefined;
  rotuloProgresso?: string;
  faixaBoa?: [number, number];
  marcadores?: (x: Exec) => Marcador[];
  /** Precisa do motor ligado: se ele apagar, o treino explica por quê e pede nova partida. */
  requerMotor?: boolean;
  /** Para onde voltar depois de religar (padrão: este passo). */
  aoApagar?: string;
  /** Erro que obriga a refazer (ex.: recuou na rampa): devolve a explicação. */
  falhou?: (x: Exec) => string | null;
  /** Passo para onde ir quando falhar (padrão: este). */
  seFalhar?: string;
  /** "Repetir" volta para este passo (padrão: o próprio). */
  repetirDe?: string;
  /** Sem "Muito bem!" ao concluir (preparação). */
  semFesta?: boolean;
  /** Frase do "Muito bem!" deste passo. */
  festa?: string;
}

export interface DefLicao {
  id: IdLicao;
  titulo: string;
  descricao: string;
  passos: Passo[];
  aoIniciar?: (x: Exec) => void;
  /** Marcadores que valem durante a lição toda (o passo pode trocar). */
  marcadores?: (x: Exec) => Marcador[];
  /** Texto final (resumo). */
  resumo?: (x: Exec) => string;
}

export function texto(t: Texto | undefined, x: Exec): string | undefined {
  return typeof t === 'function' ? t(x) : t;
}

/** Passo de explicação simples. */
export function leitura(id: string, titulo: string, txt: Texto, foco: AlvoCamera = null, extra: Partial<Passo> = {}): Passo {
  return { id, titulo, texto: txt, foco, leitura: true, semFesta: true, ...extra };
}

/** Segura uma condição por `seg` segundos (conta só enquanto ela vale). */
export function segurar(x: Exec, chave: string, cond: boolean, seg: number): boolean {
  x.mem[chave] = cond ? (x.mem[chave] ?? 0) + x.dt : 0;
  return x.mem[chave] >= seg;
}

/** Sequência de sub-objetivos: marca cada um quando acontece (em ordem) e devolve quantos já foram. */
export function sequencia(x: Exec, chave: string, conds: (() => boolean)[]): number {
  let i: number = x.mem[chave] ?? 0;
  while (i < conds.length && conds[i]()) i++;
  x.mem[chave] = i;
  return i;
}

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
