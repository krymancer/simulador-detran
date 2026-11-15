/**
 * Menu de opções (tecla O ou botão na tela inicial). Fica salvo no navegador.
 */

export type Qualidade = 'baixa' | 'media' | 'alta';

export interface Config {
  carro: 'mobi' | 'kwid';
  /** Rotação do volante físico, batente a batente (graus). G29 = 900. */
  rotacaoVolante: number;
  /** true: o volante físico gira igual ao do carro (1:1). false: o curso todo do físico vai até o batente do carro. */
  volante1para1: boolean;
  /** Controle/teclado: quão rápido o volante gira (0,5–2). */
  sensibilidade: number;
  qualidade: Qualidade;
  horario: 'dia' | 'entardecer' | 'noite';
  /** Campo de visão no cockpit (graus). */
  fov: number;
  volume: number;
  vozExaminador: boolean;
  examinador: boolean;
  trafego: boolean;
  pedestres: boolean;
}

export const CONFIG_PADRAO: Config = {
  carro: 'mobi',
  rotacaoVolante: 900,
  volante1para1: true,
  sensibilidade: 1,
  qualidade: 'alta',
  horario: 'dia',
  fov: 68,
  volume: 0.8,
  vozExaminador: true,
  examinador: true,
  trafego: true,
  pedestres: true,
};

const CHAVE = 'detran.opcoes';

function carregar(): Config {
  try {
    const s = localStorage.getItem(CHAVE);
    if (s) return { ...CONFIG_PADRAO, ...(JSON.parse(s) as Partial<Config>) };
  } catch {
    /* sem storage */
  }
  return { ...CONFIG_PADRAO };
}

type Campo =
  | { k: keyof Config; tipo: 'sel'; rotulo: string; opcoes: [string, string][]; dica?: string }
  | { k: keyof Config; tipo: 'num'; rotulo: string; min: number; max: number; passo: number; unidade?: string; dica?: string }
  | { k: keyof Config; tipo: 'bool'; rotulo: string; dica?: string };

const CAMPOS: { titulo: string; campos: Campo[] }[] = [
  {
    titulo: 'Carro',
    campos: [{ k: 'carro', tipo: 'sel', rotulo: 'Modelo', opcoes: [['mobi', 'Fiat Mobi 1.0 (4 cil.)'], ['kwid', 'Renault Kwid 1.0 (3 cil.)']] }],
  },
  {
    titulo: 'Direção',
    campos: [
      { k: 'rotacaoVolante', tipo: 'num', rotulo: 'Rotação do volante físico', min: 180, max: 1080, passo: 90, unidade: '°', dica: 'G29: 900°. Ajuste igual ao configurado no driver.' },
      { k: 'volante1para1', tipo: 'bool', rotulo: 'Volante 1:1', dica: 'Ligado: girar 90° no seu volante gira 90° no do carro. Desligado: o curso todo vai até o batente do carro.' },
      { k: 'sensibilidade', tipo: 'num', rotulo: 'Sensibilidade (controle/teclado)', min: 0.5, max: 2, passo: 0.1, unidade: '×' },
    ],
  },
  {
    titulo: 'Prova',
    campos: [
      { k: 'examinador', tipo: 'bool', rotulo: 'Examinador com percurso' },
      { k: 'vozExaminador', tipo: 'bool', rotulo: 'Voz do examinador' },
      { k: 'trafego', tipo: 'bool', rotulo: 'Trânsito (outros carros)' },
      { k: 'pedestres', tipo: 'bool', rotulo: 'Pedestres' },
    ],
  },
  {
    titulo: 'Imagem e som',
    campos: [
      { k: 'horario', tipo: 'sel', rotulo: 'Horário', opcoes: [['dia', 'Dia'], ['entardecer', 'Entardecer'], ['noite', 'Noite']], dica: 'À noite, ligue o farol (L / ○ no G29).' },
      { k: 'qualidade', tipo: 'sel', rotulo: 'Qualidade gráfica', opcoes: [['alta', 'Alta'], ['media', 'Média'], ['baixa', 'Baixa (PC fraco)']], dica: 'Baixa: sem sombras, resolução menor e espelhos mais leves.' },
      { k: 'fov', tipo: 'num', rotulo: 'Campo de visão (cockpit)', min: 50, max: 90, passo: 1, unidade: '°' },
      { k: 'volume', tipo: 'num', rotulo: 'Volume', min: 0, max: 1, passo: 0.05 },
    ],
  },
];

export class Opcoes {
  valores: Config = carregar();
  private readonly el: HTMLElement;
  private aberta = false;
  private ouvintes: ((c: Config, antes: Config) => void)[] = [];
  onFechar: () => void = () => {};

  constructor(pai: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'painel opcoes oculto';
    pai.appendChild(this.el);
    this.montar();
  }

  get estaAberta(): boolean {
    return this.aberta;
  }

  aoMudar(cb: (c: Config, antes: Config) => void): void {
    this.ouvintes.push(cb);
  }

  abrir(): void {
    this.aberta = true;
    this.montar();
    this.el.classList.remove('oculto');
  }

  fechar(): void {
    this.aberta = false;
    this.el.classList.add('oculto');
    this.onFechar();
  }

  private definir<K extends keyof Config>(k: K, v: Config[K]): void {
    const antes = { ...this.valores };
    this.valores = { ...this.valores, [k]: v };
    try {
      localStorage.setItem(CHAVE, JSON.stringify(this.valores));
    } catch {
      /* sem storage */
    }
    for (const cb of this.ouvintes) cb(this.valores, antes);
  }

  private montar(): void {
    const v = this.valores;
    let html = '<h2>Opções</h2>';
    for (const sec of CAMPOS) {
      html += `<h3>${sec.titulo}</h3><div class="campos">`;
      for (const c of sec.campos) {
        const atual = v[c.k];
        let ctrl = '';
        if (c.tipo === 'sel') {
          ctrl = `<select data-k="${c.k}">${c.opcoes.map(([val, txt]) => `<option value="${val}" ${val === atual ? 'selected' : ''}>${txt}</option>`).join('')}</select>`;
        } else if (c.tipo === 'num') {
          ctrl = `<input type="range" data-k="${c.k}" min="${c.min}" max="${c.max}" step="${c.passo}" value="${atual}"><output>${Number(atual).toFixed(c.passo < 1 ? (c.passo < 0.1 ? 2 : 1) : 0)}${c.unidade ?? ''}</output>`;
        } else {
          ctrl = `<input type="checkbox" data-k="${c.k}" ${atual ? 'checked' : ''}>`;
        }
        html += `<label class="campo"><span>${c.rotulo}${c.dica ? `<small>${c.dica}</small>` : ''}</span><span class="ctrl">${ctrl}</span></label>`;
      }
      html += '</div>';
    }
    html += `<div class="botoes"><button data-acao="padrao">Restaurar padrão</button><button data-acao="fechar">Fechar (O)</button></div>`;
    this.el.innerHTML = html;

    this.el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((inp) => {
      const k = inp.dataset.k as keyof Config;
      const campo = CAMPOS.flatMap((s) => s.campos).find((c) => c.k === k)!;
      inp.addEventListener(inp.type === 'range' ? 'input' : 'change', () => {
        if (campo.tipo === 'bool') this.definir(k, (inp as HTMLInputElement).checked as never);
        else if (campo.tipo === 'num') {
          const n = Number(inp.value);
          const out = inp.nextElementSibling as HTMLOutputElement | null;
          if (out) out.textContent = `${n.toFixed(campo.passo < 1 ? (campo.passo < 0.1 ? 2 : 1) : 0)}${campo.unidade ?? ''}`;
          this.definir(k, n as never);
        } else this.definir(k, inp.value as never);
      });
    });
    this.el.querySelector<HTMLButtonElement>('[data-acao="fechar"]')!.onclick = () => this.fechar();
    this.el.querySelector<HTMLButtonElement>('[data-acao="padrao"]')!.onclick = () => {
      const antes = { ...this.valores };
      this.valores = { ...CONFIG_PADRAO };
      try {
        localStorage.setItem(CHAVE, JSON.stringify(this.valores));
      } catch {
        /* sem storage */
      }
      for (const cb of this.ouvintes) cb(this.valores, antes);
      this.montar();
    };
  }
}
