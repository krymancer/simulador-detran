import type { Examinador } from '../exam/examinador';

const CSS = `
.ex-faixa { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); z-index: 20;
  max-width: min(620px, calc(100vw - 32px)); box-sizing: border-box; pointer-events: none;
  background: rgba(14, 17, 22, 0.88); border: 1px solid rgba(255,255,255,.12); border-radius: 12px;
  padding: 10px 16px 9px; color: #e9edf2; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  box-shadow: 0 6px 24px rgba(0,0,0,.35); transition: opacity .25s; }
.ex-faixa.oculta { opacity: 0; }
.ex-cab { display: flex; align-items: center; gap: 8px; font-size: 11px; letter-spacing: .06em;
  text-transform: uppercase; color: #9aa5b1; margin-bottom: 4px; }
.ex-cab b { color: #ffb000; font-weight: 700; }
.ex-texto { font-size: 18px; line-height: 1.3; font-weight: 600; }
.ex-texto.nova { animation: ex-pulso .6s ease-out; }
.ex-passos { display: flex; gap: 3px; margin-top: 8px; }
.ex-passos i { flex: 1; height: 4px; border-radius: 2px; background: #2a3340; }
.ex-passos i.feito { background: #3ddc84; }
.ex-passos i.atual { background: #ffb000; }
@keyframes ex-pulso { from { color: #ffb000; transform: scale(1.02); } to { color: #e9edf2; transform: none; } }
@media (max-width: 520px) { .ex-texto { font-size: 15px; } }
`;

let cssInjetado = false;
function injetarCss(): void {
  if (cssInjetado) return;
  cssInjetado = true;
  const s = document.createElement('style');
  s.dataset.modulo = 'examinadorUi';
  s.textContent = CSS;
  document.head.appendChild(s);
}

/** Faixa no alto da tela com a instrução atual do examinador e o progresso do trajeto. */
export class UiExaminador {
  private readonly raiz: HTMLDivElement;
  private readonly cab: HTMLSpanElement;
  private readonly texto: HTMLDivElement;
  private readonly passos: HTMLDivElement;
  private ultimoTexto: string | null = null;
  private ultimaEtapa = -1;
  private ultimoTotal = -1;

  constructor(pai: HTMLElement) {
    injetarCss();
    this.raiz = document.createElement('div');
    this.raiz.className = 'ex-faixa oculta';
    this.raiz.setAttribute('role', 'status');
    this.raiz.setAttribute('aria-live', 'polite');
    const cab = document.createElement('div');
    cab.className = 'ex-cab';
    cab.innerHTML = '<b>Examinador</b>';
    this.cab = document.createElement('span');
    cab.appendChild(this.cab);
    this.texto = document.createElement('div');
    this.texto.className = 'ex-texto';
    this.passos = document.createElement('div');
    this.passos.className = 'ex-passos';
    this.raiz.append(cab, this.texto, this.passos);
    pai.appendChild(this.raiz);
  }

  atualizar(ex: Examinador): void {
    const txt = ex.instrucao;
    if (txt !== this.ultimoTexto) {
      this.ultimoTexto = txt;
      this.raiz.classList.toggle('oculta', !txt);
      this.texto.textContent = txt ?? '';
      // reinicia a animação
      this.texto.classList.remove('nova');
      void this.texto.offsetWidth;
      this.texto.classList.add('nova');
    }
    const total = ex.totalEtapas;
    const etapa = ex.etapa;
    if (total !== this.ultimoTotal) {
      this.ultimoTotal = total;
      this.passos.replaceChildren(...Array.from({ length: total }, () => document.createElement('i')));
      this.ultimaEtapa = -1;
    }
    if (etapa !== this.ultimaEtapa) {
      this.ultimaEtapa = etapa;
      this.cab.textContent = `· etapa ${Math.min(etapa + 1, total)} de ${total}`;
      Array.from(this.passos.children).forEach((el, i) => {
        el.className = i < etapa ? 'feito' : i === etapa ? 'atual' : '';
      });
    }
  }

  /** Esconde a faixa (pista sem examinador). */
  ocultar(): void {
    this.raiz.classList.add('oculta');
    this.ultimoTexto = null;
  }

  remover(): void {
    this.raiz.remove();
  }
}
