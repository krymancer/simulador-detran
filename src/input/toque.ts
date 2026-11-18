/**
 * Controles de toque (celular/tablet, deitado): pedais analógicos, volante na tela ou
 * inclinação do aparelho, câmbio em H e botões. Lê em `ler()` no mesmo formato que o
 * teclado/gamepad usam dentro de `Entrada`.
 *
 * Layout (paisagem):
 *   esquerda: embreagem (polegar esquerdo) e, no modo "volante", o volante ao lado dela
 *   direita:  câmbio em H, freio e acelerador (polegar direito)
 *   colunas de botões acima dos pedais; menus no canto de cima à esquerda
 *
 * Pedal: quanto mais alto o dedo dentro do pedal, mais fundo. Soltar o dedo solta o pedal
 * (como tirar o pé): para sair com o carro, deslize a embreagem para baixo devagar.
 */
import type { AcaoBotao } from './input';

export type DirecaoToque = 'volante' | 'inclinar';

export interface LeituraToque {
  volante: number | null;
  acelerador: number;
  freio: number;
  embreagem: number;
  /** Marcha escolhida no câmbio da tela neste quadro (null = não mexeu). */
  marcha: number | null;
  segurando: Set<AcaoBotao>;
  bordas: Set<AcaoBotao>;
  olhar: number;
}

/** Estado do carro para acender os botões. */
export interface EstadoBotoesToque {
  marcha: number;
  freioDeMao: boolean;
  cinto: boolean;
  farol: boolean;
  alerta: boolean;
  seta: 'esquerda' | 'direita' | null;
}

const CSS = `
.toque { position: fixed; inset: 0; z-index: 12; pointer-events: none; user-select: none; -webkit-user-select: none;
  font: 600 12px system-ui, sans-serif; color: #e9edf2; --tq-fundo: rgba(14,17,22,.55); --tq-borda: rgba(255,255,255,.22); }
.toque * { -webkit-tap-highlight-color: transparent; }
.toque .tq { position: absolute; pointer-events: auto; touch-action: none; }
.tq-pedal { width: clamp(52px, 8vw, 84px); height: min(46vh, 260px); bottom: max(12px, env(safe-area-inset-bottom));
  background: var(--tq-fundo); border: 1px solid var(--tq-borda); border-radius: 14px; overflow: hidden; }
.tq-pedal i { position: absolute; left: 0; right: 0; bottom: 0; height: 0; background: rgba(255,176,0,.55); }
.tq-pedal b { position: absolute; left: 0; right: 0; top: 8px; text-align: center; font-size: 11px; pointer-events: none; text-shadow: 0 1px 2px #000; }
.tq-pedal.freio i { background: rgba(255,77,77,.55); }
.tq-pedal.acel i { background: rgba(61,220,132,.55); }
.tq-pedal.emb i { background: rgba(74,168,255,.6); }
.tq-pedal .ponto { position: absolute; left: 0; right: 0; height: 2px; background: rgba(255,255,255,.35); pointer-events: none; }
.tq-volante { width: min(40vh, 210px); height: min(40vh, 210px); bottom: max(12px, env(safe-area-inset-bottom)); border-radius: 50%; }
.tq-volante svg { width: 100%; height: 100%; display: block; pointer-events: none; }
.tq-cambio { width: min(30vh, 150px); height: min(34vh, 170px); bottom: max(12px, env(safe-area-inset-bottom));
  display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: 1fr .7fr 1fr; gap: 4px; }
.tq-cambio div { display: flex; align-items: center; justify-content: center; background: var(--tq-fundo); border: 1px solid var(--tq-borda);
  border-radius: 10px; font-size: 18px; pointer-events: none; }
.tq-cambio div.n { grid-column: 1 / -1; font-size: 13px; color: #9aa5b1; }
.tq-cambio div.on { background: rgba(255,176,0,.75); color: #111; border-color: #ffb000; }
.tq-botoes { display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
.tq-botoes.linha { flex-direction: row; }
.tq-botoes.grade { display: grid; grid-template-columns: 1fr 1fr; width: calc(2 * clamp(52px, 8vw, 84px) + 10px); }
.tq-botoes.grade .tq-b { min-width: 0; padding: 0 4px; font-size: 11px; }
.tq-b { pointer-events: auto; touch-action: none; min-width: 48px; height: 38px; padding: 0 8px; display: flex; align-items: center; justify-content: center;
  background: var(--tq-fundo); border: 1px solid var(--tq-borda); border-radius: 10px; font: inherit; color: inherit; }
.tq-b.on { background: rgba(255,176,0,.75); color: #111; border-color: #ffb000; }
.tq-b.seta.on { background: rgba(61,220,132,.8); border-color: #3ddc84; }
.tq-b.apertado { filter: brightness(1.6); }
.toque.inclinar .tq-volante { display: none; }
`;

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', txt = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt) e.textContent = txt;
  return e;
}

const ehIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class ControlesToque {
  readonly raiz: HTMLDivElement;
  private ativo = false;
  private modo: DirecaoToque = 'volante';

  // pedais
  private pedais: Record<'embreagem' | 'freio' | 'acelerador', { el: HTMLElement; barra: HTMLElement; valor: number; dedo: number | null }>;
  // volante na tela
  private volanteEl: HTMLElement;
  private volanteSvg: SVGGElement;
  private anguloVolante = 0; // rad do volante da tela
  private dedoVolante: number | null = null;
  private anguloDedo = 0;
  // inclinação
  private inclinacao = 0;  // −1..1
  private zeroInclinacao = 0;
  private gravidade: { x: number; y: number; z: number } | null = null;
  // câmbio
  private cambioEl: HTMLElement;
  private casas = new Map<number, HTMLElement>();
  private marchaPedida: number | null = null;
  private dedoCambio: number | null = null;
  // botões
  private botoes = new Map<AcaoBotao, HTMLElement>();
  private apertados = new Map<AcaoBotao, number>(); // ação → contagem de dedos
  private bordas = new Set<AcaoBotao>();
  /** Ações extras (menus) tratadas por quem cria os controles. */
  aoAcao: (a: 'treino' | 'opcoes' | 'telaCheia' | 'zerarInclinacao') => void = () => {};

  constructor(pai: HTMLElement) {
    if (!document.getElementById('css-toque')) {
      const s = el('style');
      s.id = 'css-toque';
      s.textContent = CSS;
      document.head.append(s);
    }
    this.raiz = el('div', 'toque oculto');
    pai.append(this.raiz);

    const pedal = (cls: string, rotulo: string, lado: 'left' | 'right', pos: string) => {
      const p = el('div', `tq tq-pedal ${cls}`);
      p.style[lado] = pos;
      const barra = el('i');
      p.append(barra, el('b', '', rotulo));
      this.raiz.append(p);
      return { el: p, barra, valor: 0, dedo: null as number | null };
    };
    const margem = 'max(12px, env(safe-area-inset-left))';
    const margemD = 'max(12px, env(safe-area-inset-right))';
    this.pedais = {
      embreagem: pedal('emb', 'Embreagem', 'left', margem),
      acelerador: pedal('acel', 'Acelerador', 'right', margemD),
      freio: pedal('freio', 'Freio', 'right', `calc(${margemD} + clamp(52px, 8vw, 84px) + 10px)`),
    };
    for (const [nome, p] of Object.entries(this.pedais)) this.ligarPedal(nome as keyof typeof this.pedais, p);

    // volante na tela
    this.volanteEl = el('div', 'tq tq-volante');
    this.volanteEl.style.left = `calc(${margem} + clamp(52px, 8vw, 84px) + 14px)`;
    this.volanteEl.innerHTML = `<svg viewBox="-100 -100 200 200"><g>
      <circle r="88" fill="none" stroke="rgba(20,22,26,.85)" stroke-width="20"/>
      <circle r="88" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="2"/>
      <rect x="-6" y="-98" width="12" height="20" rx="3" fill="#ffb000"/>
      <path d="M-80 10 L-22 18 L22 18 L80 10 L80 26 L22 34 L10 78 L-10 78 L-22 34 L-80 26 Z" fill="rgba(20,22,26,.85)"/>
      <circle r="22" fill="rgba(30,33,38,.95)" stroke="rgba(255,255,255,.2)"/></g></svg>`;
    this.volanteSvg = this.volanteEl.querySelector('g')!;
    this.raiz.append(this.volanteEl);
    this.ligarVolante();

    // câmbio em H: 1 3 5 / N / 2 4 R
    this.cambioEl = el('div', 'tq tq-cambio');
    this.cambioEl.style.right = `calc(${margemD} + 2 * clamp(52px, 8vw, 84px) + 24px)`;
    for (const [m, txt] of [[1, '1'], [3, '3'], [5, '5'], [0, 'N'], [2, '2'], [4, '4'], [-1, 'R']] as const) {
      const c = el('div', m === 0 ? 'n' : '', txt);
      this.casas.set(m, c);
      this.cambioEl.append(c);
    }
    this.raiz.append(this.cambioEl);
    this.ligarCambio();

    // botões
    const coluna = (estilo: Partial<CSSStyleDeclaration>, itens: [AcaoBotao, string, string?][], cls = '') => {
      const c = el('div', `tq tq-botoes ${cls}`);
      Object.assign(c.style, estilo);
      for (const [a, txt, cls] of itens) {
        const b = el('button', `tq-b ${cls ?? ''}`, txt);
        b.type = 'button';
        this.ligarBotao(b, a);
        this.botoes.set(a, b);
        c.append(b);
      }
      this.raiz.append(c);
    };
    const acimaPedais = 'calc(max(12px, env(safe-area-inset-bottom)) + min(46vh, 260px) + 8px)';
    // acima da embreagem e do volante: setas e alerta (polegar esquerdo)
    coluna({ left: margem, bottom: acimaPedais }, [['setaEsq', '◀ Seta', 'seta'], ['alerta', '⚠', 'alerta'], ['setaDir', 'Seta ▶', 'seta']], 'linha');
    // acima do freio e do acelerador: partida, freio de mão, cinto, farol (2 × 2)
    coluna({ right: margemD, bottom: acimaPedais }, [['partida', 'Partida'], ['freioDeMao', 'Freio de mão'], ['cinto', 'Cinto'], ['farol', 'Farol']], 'grade');
    // topo à esquerda: olhar e câmera
    coluna({ left: margem, top: 'max(8px, env(safe-area-inset-top))' }, [['olharEsq', '◀ Olhar'], ['olharTras', 'Trás'], ['olharDir', 'Olhar ▶']], 'linha');
    // menus
    const menus = el('div', 'tq tq-botoes linha');
    Object.assign(menus.style, { left: margem, top: 'calc(max(8px, env(safe-area-inset-top)) + 46px)' });
    for (const [acao, txt] of [['treino', 'Treino'], ['opcoes', 'Opções'], ['telaCheia', 'Tela cheia']] as const) {
      const b = el('button', 'tq-b', txt);
      b.type = 'button';
      b.addEventListener('click', () => this.aoAcao(acao));
      menus.append(b);
    }
    // modo inclinar: no lugar do volante, o botão de marcar o centro
    const zerar = el('button', 'tq tq-b so-inclinar', 'Zerar centro do volante');
    zerar.type = 'button';
    Object.assign(zerar.style, { left: this.volanteEl.style.left, bottom: 'max(12px, env(safe-area-inset-bottom))', height: '48px' });
    zerar.addEventListener('click', () => this.aoAcao('zerarInclinacao'));
    this.raiz.append(zerar);
    const cam = el('button', 'tq-b', 'Câmera');
    cam.type = 'button';
    this.ligarBotao(cam, 'camera');
    menus.prepend(cam);
    this.raiz.append(menus);

    window.addEventListener('devicemotion', (e) => {
      const g = e.accelerationIncludingGravity;
      if (g && g.x !== null && g.y !== null && g.z !== null) this.gravidade = { x: g.x, y: g.y, z: g.z };
    });
  }

  /** Pede permissão do sensor de movimento (iOS exige um toque do usuário). */
  async pedirSensor(): Promise<void> {
    const DM = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    if (DM?.requestPermission) {
      try { await DM.requestPermission(); } catch { /* recusou */ }
    }
  }

  get estaAtivo(): boolean { return this.ativo; }

  definir(ativo: boolean, modo: DirecaoToque): void {
    this.ativo = ativo;
    this.modo = modo;
    this.raiz.classList.toggle('oculto', !ativo);
    this.raiz.classList.toggle('inclinar', modo === 'inclinar');
    for (const b of this.raiz.querySelectorAll<HTMLElement>('.so-inclinar')) b.classList.toggle('oculto', modo !== 'inclinar');
    document.body.classList.toggle('com-toque', ativo);
    if (!ativo) this.soltarTudo();
  }

  zerarInclinacao(): void {
    this.zeroInclinacao = this.inclinacaoBruta() ?? 0;
  }

  private soltarTudo(): void {
    for (const p of Object.values(this.pedais)) { p.valor = 0; p.dedo = null; p.barra.style.height = '0'; }
    this.dedoVolante = null;
    this.apertados.clear();
  }

  // ------------------------------------------------------------- pedais
  private ligarPedal(nome: keyof ControlesToque['pedais'], p: ControlesToque['pedais']['freio']): void {
    const ler = (e: PointerEvent) => {
      const r = p.el.getBoundingClientRect();
      // 6% de folga embaixo (dedo encostado = solto) e em cima (fundo sem precisar ir à borda)
      p.valor = clamp(((r.bottom - e.clientY) / r.height - 0.06) / 0.86, 0, 1);
      p.barra.style.height = `${p.valor * 100}%`;
    };
    p.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      p.dedo = e.pointerId;
      p.el.setPointerCapture(e.pointerId);
      ler(e);
    });
    p.el.addEventListener('pointermove', (e) => { if (e.pointerId === p.dedo) ler(e); });
    const soltar = (e: PointerEvent) => {
      if (e.pointerId !== p.dedo) return;
      p.dedo = null;
      p.valor = 0;
      p.barra.style.height = '0';
    };
    p.el.addEventListener('pointerup', soltar);
    p.el.addEventListener('pointercancel', soltar);
    void nome;
  }

  // ------------------------------------------------------------- volante
  private ligarVolante(): void {
    const angulo = (e: PointerEvent) => {
      const r = this.volanteEl.getBoundingClientRect();
      return Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2)));
    };
    this.volanteEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.dedoVolante = e.pointerId;
      this.volanteEl.setPointerCapture(e.pointerId);
      this.anguloDedo = angulo(e);
    });
    this.volanteEl.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.dedoVolante) return;
      const a = angulo(e);
      let d = a - this.anguloDedo;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      this.anguloDedo = a;
      this.anguloVolante = clamp(this.anguloVolante + d, -MAX_VOLANTE_TELA, MAX_VOLANTE_TELA);
    });
    const soltar = (e: PointerEvent) => { if (e.pointerId === this.dedoVolante) this.dedoVolante = null; };
    this.volanteEl.addEventListener('pointerup', soltar);
    this.volanteEl.addEventListener('pointercancel', soltar);
  }

  /** Inclinação lateral do aparelho (rad), na orientação atual da tela. */
  private inclinacaoBruta(): number | null {
    const g = this.gravidade;
    if (!g) return null;
    const ang = ((screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) * Math.PI) / 180;
    // gravidade no referencial da tela (x para a direita da tela)
    // Android dá a reação (aponta para cima); girar o aparelho para a direita deixa sx < 0.
    let sx = -(g.x * Math.cos(ang) - g.y * Math.sin(ang));
    if (ehIOS()) sx = -sx; // iOS informa a gravidade com o sinal trocado
    const n = Math.hypot(g.x, g.y, g.z) || 9.81;
    return Math.asin(clamp(sx / n, -1, 1));
  }

  // ------------------------------------------------------------- câmbio
  private ligarCambio(): void {
    const casa = (e: PointerEvent): number => {
      const r = this.cambioEl.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      if (fy > 0.38 && fy < 0.62) return 0;
      const col = clamp(Math.floor(fx * 3), 0, 2);
      return fy <= 0.38 ? [1, 3, 5][col] : [2, 4, -1][col];
    };
    this.cambioEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.dedoCambio = e.pointerId;
      this.cambioEl.setPointerCapture(e.pointerId);
      this.marchaPedida = casa(e);
    });
    // arrastar como uma alavanca: passa pelo N e entra na outra marcha
    this.cambioEl.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.dedoCambio) return;
      this.marchaPedida = casa(e);
    });
    const soltar = (e: PointerEvent) => { if (e.pointerId === this.dedoCambio) this.dedoCambio = null; };
    this.cambioEl.addEventListener('pointerup', soltar);
    this.cambioEl.addEventListener('pointercancel', soltar);
  }

  // ------------------------------------------------------------- botões
  private ligarBotao(b: HTMLElement, a: AcaoBotao): void {
    const dedos = new Set<number>();
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      if (!dedos.size) this.bordas.add(a);
      dedos.add(e.pointerId);
      this.apertados.set(a, dedos.size);
      b.classList.add('apertado');
    });
    const soltar = (e: PointerEvent) => {
      dedos.delete(e.pointerId);
      if (!dedos.size) { this.apertados.delete(a); b.classList.remove('apertado'); }
    };
    b.addEventListener('pointerup', soltar);
    b.addEventListener('pointercancel', soltar);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ------------------------------------------------------------- leitura
  ler(dt: number): LeituraToque | null {
    if (!this.ativo) return null;
    let volante: number;
    if (this.modo === 'inclinar') {
      const bruta = this.inclinacaoBruta();
      if (bruta !== null) {
        const x = clamp((bruta - this.zeroInclinacao) / INCLINACAO_MAX, -1, 1);
        const alvo = Math.sign(x) * Math.pow(Math.abs(x), 1.4);
        this.inclinacao += (alvo - this.inclinacao) * Math.min(1, dt * 12);
      }
      volante = this.inclinacao;
    } else {
      // solto: o volante volta sozinho para o centro (como o carro faz andando)
      if (this.dedoVolante === null) {
        const passo = 4 * dt;
        this.anguloVolante -= clamp(this.anguloVolante, -passo, passo);
      }
      volante = this.anguloVolante / MAX_VOLANTE_TELA;
    }
    const segurando = new Set(this.apertados.keys());
    const bordas = new Set(this.bordas);
    this.bordas.clear();
    const marcha = this.marchaPedida;
    this.marchaPedida = null;
    const olhar = (segurando.has('olharDir') ? 1 : 0) - (segurando.has('olharEsq') ? 1 : 0);
    return {
      volante,
      acelerador: this.pedais.acelerador.valor,
      freio: this.pedais.freio.valor,
      embreagem: this.pedais.embreagem.valor,
      marcha,
      segurando,
      bordas,
      olhar,
    };
  }

  /** Acende os botões conforme o estado do carro e gira o volante desenhado. */
  atualizarUi(e: EstadoBotoesToque, volante: number): void {
    if (!this.ativo) return;
    for (const [m, c] of this.casas) c.classList.toggle('on', m === e.marcha);
    this.botoes.get('freioDeMao')?.classList.toggle('on', e.freioDeMao);
    this.botoes.get('cinto')?.classList.toggle('on', e.cinto);
    this.botoes.get('farol')?.classList.toggle('on', e.farol);
    this.botoes.get('alerta')?.classList.toggle('on', e.alerta);
    this.botoes.get('setaEsq')?.classList.toggle('on', e.seta === 'esquerda');
    this.botoes.get('setaDir')?.classList.toggle('on', e.seta === 'direita');
    this.volanteSvg.setAttribute('transform', `rotate(${(volante * MAX_VOLANTE_TELA * 180) / Math.PI})`);
  }
}

/** Giro do volante da tela até o batente (rad). Menos que o real: o dedo dá no máximo ~1 volta. */
const MAX_VOLANTE_TELA = Math.PI * 1.25;
/** Inclinação do aparelho que dá o volante todo (rad). */
const INCLINACAO_MAX = (40 * Math.PI) / 180;

/** Aparelho de toque como entrada principal (celular/tablet). */
export function temToque(): boolean {
  return matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).get('toque') === '1';
}
