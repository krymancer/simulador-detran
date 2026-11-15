import type * as THREE from 'three';
import type { Acao, EstadoEntrada } from '../input/input';
import type { Simulacao } from '../sim/simulation';

/**
 * Tipos do modo "Treino guiado". Nada aqui usa DOM, canvas ou voz: tudo o que é
 * de tela/som passa pelo ContextoTreino (main.ts) e por render/treinoUi.ts.
 */

export type IdLicao = 'conhecer_carro' | 'sair_trocar_parar' | 'placas' | 'rampa' | 'baliza';

export type AlvoCamera =
  | 'volante' | 'pedais' | 'cambio' | 'freioDeMao'
  | 'espelhoCentro' | 'espelhoEsq' | 'espelhoDir'
  | 'painel' | 'frente' | null;

export type Dispositivo = 'volante' | 'controle' | 'teclado';

export interface ContextoTreino {
  sim: Simulacao;
  entrada: () => EstadoEntrada;
  perfilControles: () => { dispositivo: Dispositivo; nomeDe: (acao: Acao) => string };
  focarCamera: (alvo: AlvoCamera) => void;
  /**
   * Reposiciona o carro na planta (px) e zera o estado do carro.
   * yaw no mesmo sentido de `Veiculo.posicionar`/`mapa.spawn.yaw`: frente = (sen yaw, 0, cos yaw);
   * norte da planta (−Z) = π, leste (+X) = π/2, sul = 0, oeste = −π/2.
   */
  teleportar: (pxX: number, pxY: number, yawRad: number) => void;
  falar: (texto: string) => void;
}

export interface Licao {
  id: IdLicao;
  titulo: string;
  descricao: string;
  passos: number;
}

export interface Quiz {
  pergunta: string;
  opcoes: string[];
  correta: number;
  explicacao: string;
}

/** Marcas de referência no chão / destaques para a lição (desenhadas por GuiasTreino em treinoUi.ts). */
export interface Marcador {
  id: string;
  /** 'linha' = faixa transversal no chão; 'seta' = seta no chão; 'alvo' = retângulo (vaga); 'poste' = anel em volta de uma haste. */
  tipo: 'linha' | 'seta' | 'alvo' | 'poste';
  posicao: THREE.Vector3;
  /** Direção (mesmo yaw do carro): para onde a seta aponta / eixo comprido do retângulo. */
  yaw: number;
  /** Largura (m, transversal) e comprimento (m, ao longo do yaw). */
  largura: number;
  comprimento: number;
  cor: number;
  rotulo?: string;
  /** Pisca (é a referência que o aluno deve procurar agora). */
  ativo?: boolean;
}

export type TipoMensagem = 'sucesso' | 'erro' | 'info';

/** O que o painel mostra do passo atual. */
export interface InfoPasso {
  indice: number;
  total: number;
  titulo: string;
  texto: string;
  dica?: string;
  progresso?: number;
  /** extras (opcionais) para a UI */
  id: string;
  tipo: 'acao' | 'leitura' | 'quiz' | 'fim';
  /** Rótulo do medidor de progresso (ex.: "Ponto da embreagem"). */
  rotuloProgresso?: string;
  /** Faixa "boa" do medidor (0..1), para pintar de verde. */
  faixaBoa?: [number, number];
  quiz?: { pergunta: string; opcoes: string[]; escolhida: number | null; correta: number | null; teclas: string[] };
  mensagem?: { texto: string; tipo: TipoMensagem };
  celebrando: boolean;
}
