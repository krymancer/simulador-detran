/**
 * Entrada: teclado + qualquer número de gamepads (controle Xbox/PS, Logitech G29,
 * câmbio H) pela Gamepad API. Cada dispositivo tem um perfil de vínculos salvo
 * no localStorage, criado pela tela de calibração.
 */

export const EIXOS = ['volante', 'acelerador', 'freio', 'embreagem', 'olhar'] as const;
export const BOTOES = [
  'marcha1', 'marcha2', 'marcha3', 'marcha4', 'marcha5', 'marchaR',
  'marchaMais', 'marchaMenos',
  'freioDeMao', 'partida', 'setaEsq', 'setaDir', 'farol', 'alerta', 'cinto',
  'olharEsq', 'olharDir', 'olharTras', 'camera', 'encerrar', 'reiniciar',
] as const;

export type AcaoEixo = (typeof EIXOS)[number];
export type AcaoBotao = (typeof BOTOES)[number];
export type Acao = AcaoEixo | AcaoBotao;

export type Vinculo =
  /** Eixo: valor = (bruto − repouso) / (fim − repouso). No volante, repouso = centro e fim = batente direito. */
  | { tipo: 'eixo'; indice: number; repouso: number; fim: number }
  /** Botão (digital ou analógico, ex.: gatilhos do controle). */
  | { tipo: 'botao'; indice: number }
  /** Eixo usado como botão: “apertado” quando o eixo está perto de `alvo` (ex.: direcional/hat do volante). */
  | { tipo: 'eixoBotao'; indice: number; alvo: number };

export interface Perfil {
  id: string;
  tipo: 'volante' | 'controle';
  vinculos: Partial<Record<Acao, Vinculo>>;
  calibrado: boolean;
  /** Versão do perfil padrão (para atualizar perfis salvos antigos). */
  versao?: number;
}

const VERSAO_PERFIL = 3;

export const NOMES_ACAO: Record<Acao, string> = {
  volante: 'Volante / direção',
  acelerador: 'Acelerador',
  freio: 'Freio',
  embreagem: 'Embreagem',
  olhar: 'Olhar para os lados (eixo)',
  marcha1: '1ª marcha', marcha2: '2ª marcha', marcha3: '3ª marcha', marcha4: '4ª marcha', marcha5: '5ª marcha',
  marchaR: 'Ré',
  marchaMais: 'Subir marcha (sequencial)',
  marchaMenos: 'Descer marcha (sequencial)',
  freioDeMao: 'Freio de mão',
  partida: 'Partida / desligar',
  setaEsq: 'Seta esquerda',
  setaDir: 'Seta direita',
  farol: 'Farol',
  alerta: 'Pisca-alerta',
  cinto: 'Cinto de segurança',
  olharEsq: 'Olhar à esquerda',
  olharDir: 'Olhar à direita',
  olharTras: 'Olhar para trás (segurar)',
  camera: 'Trocar câmera',
  encerrar: 'Encerrar prova',
  reiniciar: 'Reiniciar carro',
};

const CHAVE = 'detran.perfil.';

export function salvarPerfil(p: Perfil): void {
  try {
    localStorage.setItem(CHAVE + p.id, JSON.stringify(p));
  } catch {
    /* sem storage: perfil só vale nesta sessão */
  }
}

function carregarPerfil(id: string): Perfil | null {
  try {
    const s = localStorage.getItem(CHAVE + id);
    return s ? (JSON.parse(s) as Perfil) : null;
  } catch {
    return null;
  }
}

/** Logitech G29/G923 (PlayStation) pelo id que o Chrome mostra: "... (Vendor: 046d Product: c24f)". */
export function ehG29(gp: Gamepad): boolean {
  return /046d.*(c24f|c260|c266|c267)|g29|g923/i.test(gp.id);
}

export function ehVolante(gp: Gamepad): boolean {
  return ehG29(gp) || /g920|g25|g27|driving force|wheel|fanatec|thrustmaster/i.test(gp.id) || gp.mapping !== 'standard';
}

/**
 * Perfil padrão do G29, pela ordem do descritor HID do volante (hat, X volante,
 * Z acelerador, Rz freio, Y embreagem) e por onde o Chrome coloca cada eixo:
 *  - Windows/macOS: pelo “usage”  → volante 0, embreagem 1, acelerador 2, freio 5, direcional 9
 *  - Linux (evdev): na ordem dos códigos → volante 0, embreagem 1, acelerador 2, freio 3, direcional 4/5
 * Pedal solto = +1, no fundo = −1. Botões: X, □, ○, △, borboleta dir., borboleta esq.,
 * R2, L2, Share, Options, R3, L3, câmbio 1ª–6ª (12–17), ré (18), +, −, …
 */
function perfilG29(gp: Gamepad): Perfil {
  const linux = gp.axes.length < 9;
  const pedal = (indice: number): Vinculo => ({ tipo: 'eixo', indice, repouso: 1, fim: -1 });
  const vinculos: Partial<Record<Acao, Vinculo>> = {
    volante: { tipo: 'eixo', indice: 0, repouso: 0, fim: 1 },
    embreagem: pedal(1),
    acelerador: pedal(2),
    freio: pedal(linux ? 3 : 5),
    marcha1: { tipo: 'botao', indice: 12 },
    marcha2: { tipo: 'botao', indice: 13 },
    marcha3: { tipo: 'botao', indice: 14 },
    marcha4: { tipo: 'botao', indice: 15 },
    marcha5: { tipo: 'botao', indice: 16 },
    marchaR: { tipo: 'botao', indice: 18 },
    freioDeMao: { tipo: 'botao', indice: 0 },  // X
    cinto: { tipo: 'botao', indice: 1 },       // □
    farol: { tipo: 'botao', indice: 2 },       // ○
    partida: { tipo: 'botao', indice: 3 },     // △
    setaDir: { tipo: 'botao', indice: 4 },     // borboleta direita
    setaEsq: { tipo: 'botao', indice: 5 },     // borboleta esquerda
    camera: { tipo: 'botao', indice: 6 },      // R2
    alerta: { tipo: 'botao', indice: 7 },      // L2
    reiniciar: { tipo: 'botao', indice: 8 },   // Share
    encerrar: { tipo: 'botao', indice: 9 },    // Options
    // Direcional: olhar para os lados
    olharEsq: linux ? { tipo: 'eixoBotao', indice: 4, alvo: -1 } : { tipo: 'eixoBotao', indice: 9, alvo: 0.714 },
    olharDir: linux ? { tipo: 'eixoBotao', indice: 4, alvo: 1 } : { tipo: 'eixoBotao', indice: 9, alvo: -0.428 },
    olharTras: { tipo: 'botao', indice: 11 }, // L3 (botão ao lado do direcional)
  };
  return { id: gp.id, tipo: 'volante', calibrado: true, vinculos, versao: VERSAO_PERFIL };
}

export function perfilPadrao(gp: Gamepad): Perfil {
  if (ehG29(gp)) return perfilG29(gp);
  if (gp.mapping === 'standard' && !ehVolante(gp)) {
    return {
      id: gp.id,
      tipo: 'controle',
      calibrado: true,
      versao: VERSAO_PERFIL,
      vinculos: {
        volante: { tipo: 'eixo', indice: 0, repouso: 0, fim: 1 },
        acelerador: { tipo: 'botao', indice: 7 },
        freio: { tipo: 'botao', indice: 6 },
        embreagem: { tipo: 'eixo', indice: 3, repouso: 0, fim: 1 }, // analógico direito para baixo
        olhar: { tipo: 'eixo', indice: 2, repouso: 0, fim: 1 },      // analógico direito para os lados
        // Controle não tem câmbio H: marchas no RB/LB.
        marchaMais: { tipo: 'botao', indice: 5 },
        marchaMenos: { tipo: 'botao', indice: 4 },
        freioDeMao: { tipo: 'botao', indice: 0 },
        camera: { tipo: 'botao', indice: 1 },
        cinto: { tipo: 'botao', indice: 2 },
        partida: { tipo: 'botao', indice: 3 },
        reiniciar: { tipo: 'botao', indice: 8 },
        encerrar: { tipo: 'botao', indice: 9 },
        olharTras: { tipo: 'botao', indice: 11 }, // apertar o analógico direito
        farol: { tipo: 'botao', indice: 12 },
        alerta: { tipo: 'botao', indice: 13 },
        setaEsq: { tipo: 'botao', indice: 14 },
        setaDir: { tipo: 'botao', indice: 15 },
      },
    };
  }
  // Outro volante: só a direção; o resto se mapeia na tela de controles.
  return {
    id: gp.id,
    tipo: 'volante',
    calibrado: false,
    versao: VERSAO_PERFIL,
    vinculos: { volante: { tipo: 'eixo', indice: 0, repouso: 0, fim: 1 } },
  };
}

/** Texto curto de um vínculo, para a tabela de controles. */
export function descreverVinculo(v: Vinculo | undefined): string {
  if (!v) return '—';
  if (v.tipo === 'botao') return `Botão ${v.indice}`;
  if (v.tipo === 'eixoBotao') return `Eixo ${v.indice} → ${v.alvo.toFixed(2)}`;
  return `Eixo ${v.indice} (${v.repouso.toFixed(2)} → ${v.fim.toFixed(2)})`;
}

export function lerVinculo(gp: Gamepad, v: Vinculo | undefined): number {
  if (!v) return 0;
  if (v.tipo === 'botao') {
    const b = gp.buttons[v.indice];
    return b ? b.value || (b.pressed ? 1 : 0) : 0;
  }
  const raw = gp.axes[v.indice];
  if (v.tipo === 'eixoBotao') return raw !== undefined && Math.abs(raw - v.alvo) < 0.12 ? 1 : 0;
  if (raw === undefined || v.fim === v.repouso) return 0;
  return (raw - v.repouso) / (v.fim - v.repouso);
}

/** Estado de entrada consolidado por frame. */
export interface EstadoEntrada {
  volante: number;
  acelerador: number;
  freio: number;
  embreagem: number;
  /** Marcha pedida: −1 ré, 0 neutro, 1..5 */
  marcha: number;
  freioDeMao: boolean;
  partida: boolean;         // segurando
  partidaBorda: boolean;    // apertou neste frame
  seta: 'esquerda' | 'direita' | null;
  cinto: boolean;
  farol: boolean;
  alerta: boolean;
  /** −1 (olhar à esquerda) … +1 (à direita) */
  olhar: number;
  /** Segurando o botão de olhar para trás. */
  olharTras: boolean;
  bordas: Set<AcaoBotao>;
  temVolante: boolean;
}

const TECLAS: Partial<Record<string, AcaoBotao>> = {
  Digit1: 'marcha1', Digit2: 'marcha2', Digit3: 'marcha3', Digit4: 'marcha4', Digit5: 'marcha5',
  KeyR: 'marchaR',
  Space: 'freioDeMao', KeyI: 'partida', KeyQ: 'setaEsq', KeyE: 'setaDir', KeyC: 'cinto', KeyV: 'camera',
  KeyL: 'farol', KeyK: 'alerta', KeyZ: 'olharEsq', KeyX: 'olharDir', KeyB: 'olharTras',
  Enter: 'encerrar', Backspace: 'reiniciar',
};

const zonaMorta = (x: number, z: number) => (Math.abs(x) < z ? 0 : (x - Math.sign(x) * z) / (1 - z));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export class Entrada {
  private teclas = new Set<string>();
  private teclasBorda = new Set<string>();
  private perfis = new Map<string, Perfil>();
  private anteriores = new Map<string, Set<AcaoBotao>>();

  private tecladoVolante = 0;
  private tecladoAcel = 0;
  private tecladoFreio = 0;
  private tecladoEmbreagem = 0;
  private controleVolante = 0;

  private marchaSequencial = 0;
  private freioDeMao = true;
  private seta: 'esquerda' | 'direita' | null = null;
  private setaVirou = false;
  private cinto = false;
  private farol = false;
  private alerta = false;

  /** Enquanto a calibração está aberta, o jogo não lê nada. */
  pausado = false;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (TECLAS[e.code] || /Arrow|KeyW|KeyA|KeyS|KeyD|Shift|KeyN|Digit0/.test(e.code)) e.preventDefault();
      this.teclas.add(e.code);
      this.teclasBorda.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.teclas.delete(e.code));
    window.addEventListener('blur', () => this.teclas.clear());
  }

  gamepads(): Gamepad[] {
    return (navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g && g.connected);
  }

  perfil(gp: Gamepad): Perfil {
    let p = this.perfis.get(gp.id);
    if (!p) {
      const salvo = carregarPerfil(gp.id);
      const padrao = perfilPadrao(gp);
      if (!salvo || (salvo.versao ?? 1) < 2) p = padrao;
      else if ((salvo.versao ?? 1) < VERSAO_PERFIL) {
        // Perfil antigo: mantém o que o jogador mudou e só acrescenta comandos novos cujo botão/eixo está livre.
        const usados = new Set(Object.values(salvo.vinculos).map((v) => `${v!.tipo}:${v!.indice}`));
        const vinculos = { ...salvo.vinculos };
        for (const [a, v] of Object.entries(padrao.vinculos)) {
          if (!vinculos[a as Acao] && !usados.has(`${v!.tipo}:${v!.indice}`)) vinculos[a as Acao] = v;
        }
        p = { ...salvo, vinculos, versao: VERSAO_PERFIL };
        salvarPerfil(p);
      } else p = salvo;
      this.perfis.set(gp.id, p);
    }
    return p;
  }

  definirPerfil(p: Perfil): void {
    this.perfis.set(p.id, p);
    salvarPerfil(p);
  }

  /** Dispositivos que ainda precisam de calibração. */
  semCalibracao(): Gamepad[] {
    return this.gamepads().filter((g) => !this.perfil(g).calibrado);
  }

  ler(dt: number): EstadoEntrada {
    const bordas = new Set<AcaoBotao>();
    const segurando = new Set<AcaoBotao>();
    let volante = 0;
    let acelerador = 0;
    let freio = 0;
    let embreagem = 0;
    let temVolante = false;
    let marchaH: number | null = null;
    let temCambioH = false;
    let volanteControle: number | null = null;
    let olhar = 0;

    if (!this.pausado) {
      // --- Gamepads ---
      for (const gp of this.gamepads()) {
        const p = this.perfil(gp);
        const v = p.vinculos;
        const ant = this.anteriores.get(gp.id) ?? new Set<AcaoBotao>();
        const agora = new Set<AcaoBotao>();
        for (const b of BOTOES) {
          if (lerVinculo(gp, v[b]) > 0.5) {
            agora.add(b);
            segurando.add(b);
            if (!ant.has(b)) bordas.add(b);
          }
        }
        this.anteriores.set(gp.id, agora);

        if (v.marcha1 || v.marcha2 || v.marchaR) {
          temCambioH = true;
          const ordem: [AcaoBotao, number][] = [['marcha1', 1], ['marcha2', 2], ['marcha3', 3], ['marcha4', 4], ['marcha5', 5], ['marchaR', -1]];
          for (const [a, m] of ordem) if (agora.has(a)) marchaH = m;
        }

        const s = Math.max(-1, Math.min(1, lerVinculo(gp, v.volante)));
        if (p.tipo === 'volante') {
          temVolante = true;
          if (Math.abs(s) > Math.abs(volante)) volante = s;
        } else {
          const z = zonaMorta(s, 0.08);
          // Curva não-linear para precisão no centro.
          const alvo = Math.sign(z) * Math.pow(Math.abs(z), 1.6);
          if (volanteControle === null || Math.abs(alvo) > Math.abs(volanteControle)) volanteControle = alvo;
        }
        acelerador = Math.max(acelerador, clamp01(zonaMorta(lerVinculo(gp, v.acelerador), 0.02)));
        freio = Math.max(freio, clamp01(zonaMorta(lerVinculo(gp, v.freio), 0.02)));
        embreagem = Math.max(embreagem, clamp01(zonaMorta(lerVinculo(gp, v.embreagem), p.tipo === 'controle' ? 0.1 : 0.02)));
        const o = zonaMorta(Math.max(-1, Math.min(1, lerVinculo(gp, v.olhar))), 0.15);
        if (Math.abs(o) > Math.abs(olhar)) olhar = o;
      }

      // Controle: volante com taxa limitada (simula girar o volante com as mãos)
      if (volanteControle !== null) {
        const taxa = 2.5 * dt;
        this.controleVolante += Math.max(-taxa, Math.min(taxa, volanteControle - this.controleVolante));
        if (Math.abs(this.controleVolante) > Math.abs(volante)) volante = this.controleVolante;
      }

      // --- Teclado ---
      const k = (...c: string[]) => c.some((x) => this.teclas.has(x));
      const alvoV = (k('ArrowRight', 'KeyD') ? 1 : 0) - (k('ArrowLeft', 'KeyA') ? 1 : 0);
      const taxaV = (alvoV === 0 ? 2.5 : 1.6) * dt;
      this.tecladoVolante += Math.max(-taxaV, Math.min(taxaV, alvoV - this.tecladoVolante));
      const rampa = (atual: number, alvo: number, sobe: number, desce: number) =>
        alvo > atual ? Math.min(alvo, atual + sobe * dt) : Math.max(alvo, atual - desce * dt);
      this.tecladoAcel = rampa(this.tecladoAcel, k('ArrowUp', 'KeyW') ? 1 : 0, 2.5, 5);
      this.tecladoFreio = rampa(this.tecladoFreio, k('ArrowDown', 'KeyS') ? 1 : 0, 3, 6);
      // Embreagem no teclado: pisa rápido, solta devagar (passa pelo ponto).
      this.tecladoEmbreagem = rampa(this.tecladoEmbreagem, k('ShiftLeft', 'ShiftRight') ? 1 : 0, 6, 0.7);
      if (Math.abs(this.tecladoVolante) > Math.abs(volante)) volante = this.tecladoVolante;
      acelerador = Math.max(acelerador, this.tecladoAcel);
      freio = Math.max(freio, this.tecladoFreio);
      embreagem = Math.max(embreagem, this.tecladoEmbreagem);

      for (const code of this.teclasBorda) {
        const a = TECLAS[code];
        if (a) bordas.add(a);
        if (code === 'KeyN' || code === 'Digit0') this.marchaSequencial = 0;
      }
      for (const code of this.teclas) {
        const a = TECLAS[code];
        if (a) segurando.add(a);
      }
    }
    this.teclasBorda.clear();

    // --- Marchas ---
    const seq: number[] = [-1, 0, 1, 2, 3, 4, 5];
    if (bordas.has('marchaMais')) this.marchaSequencial = seq[Math.min(seq.length - 1, seq.indexOf(this.marchaSequencial) + 1)];
    if (bordas.has('marchaMenos')) this.marchaSequencial = seq[Math.max(0, seq.indexOf(this.marchaSequencial) - 1)];
    // Teclas numéricas fixam a marcha (como sequencial)
    const teclaMarcha: [AcaoBotao, number][] = [['marcha1', 1], ['marcha2', 2], ['marcha3', 3], ['marcha4', 4], ['marcha5', 5], ['marchaR', -1]];
    for (const [a, m] of teclaMarcha) {
      if (bordas.has(a) && !temCambioH) this.marchaSequencial = m;
    }
    const marcha = temCambioH ? (marchaH ?? 0) : this.marchaSequencial;
    if (temCambioH) this.marchaSequencial = marcha;

    // --- Alavancas / botões com trava ---
    if (bordas.has('freioDeMao')) this.freioDeMao = !this.freioDeMao;
    if (bordas.has('cinto')) this.cinto = !this.cinto;
    if (bordas.has('farol')) this.farol = !this.farol;
    if (bordas.has('alerta')) this.alerta = !this.alerta;
    if (segurando.has('olharEsq')) olhar = -1;
    if (segurando.has('olharDir')) olhar = 1;
    if (bordas.has('setaEsq')) { this.seta = this.seta === 'esquerda' ? null : 'esquerda'; this.setaVirou = false; }
    if (bordas.has('setaDir')) { this.seta = this.seta === 'direita' ? null : 'direita'; this.setaVirou = false; }
    // A seta desarma sozinha quando o volante volta depois da curva.
    if (this.seta) {
      const lado = this.seta === 'esquerda' ? -1 : 1;
      if (volante * lado > 0.3) this.setaVirou = true;
      else if (this.setaVirou && volante * lado < 0.08) { this.seta = null; this.setaVirou = false; }
    }

    return {
      volante: Math.max(-1, Math.min(1, volante)),
      acelerador,
      freio,
      embreagem,
      marcha,
      freioDeMao: this.freioDeMao,
      partida: segurando.has('partida'),
      partidaBorda: bordas.has('partida'),
      seta: this.seta,
      cinto: this.cinto,
      farol: this.farol,
      alerta: this.alerta,
      olhar,
      olharTras: segurando.has('olharTras'),
      bordas,
      temVolante,
    };
  }

  reiniciarCabine(): void {
    this.freioDeMao = true;
    this.cinto = false;
    this.seta = null;
    this.alerta = false;
    this.marchaSequencial = 0;
  }
}
