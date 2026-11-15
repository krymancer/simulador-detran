import type { Falta, Prova } from '../exam/exam';
import { Gravidade, LIMITE_PONTOS, PONTOS, ROTULO_GRAVIDADE, VELOCIDADE_MAXIMA } from '../exam/regras';
import { METROS_POR_PX } from '../world/autoescola';

/** Uma tentativa salva no histórico (localStorage do navegador). */
export interface RegistroProva {
  /** Data/hora ISO do fim da prova. */
  data: string;
  aprovado: boolean;
  /** Prova interrompida (colisão/atropelamento). */
  interrompida: boolean;
  pontos: number;
  limite: number;
  /** Duração (s). */
  duracao: number;
  faltas: number;
}

export interface OpcoesRelatorio {
  /** URL da planta (src/world/autoescola/chao.png). */
  urlMapa: string;
  onNovaProva: () => void;
  onFechar: () => void;
}

const CHAVE_HISTORICO = 'simulador-detran.historico';
const MAX_HISTORICO = 10;
/** Tamanho da planta em px (usado até a imagem carregar). */
const PLANTA_W = 1600;
const PLANTA_H = 1516;

const COR: Record<Gravidade, string> = {
  eliminatoria: '#ff4d4d',
  gravissima: '#ff5d73',
  grave: '#ff8a65',
  media: '#ffb000',
  leve: '#8ec5ff',
};

const CSS = `
.rel-fundo { position: fixed; inset: 0; z-index: 100; background: rgba(5, 7, 10, .72); display: flex;
  align-items: center; justify-content: center; padding: 16px; box-sizing: border-box;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #e9edf2; }
.rel-cartao { background: #12161c; border: 1px solid rgba(255,255,255,.12); border-radius: 14px;
  width: min(940px, 100%); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box;
  padding: 20px 22px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
.rel-topo { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 4px; }
.rel-resultado { font-size: 30px; font-weight: 800; letter-spacing: .04em; }
.rel-resultado.ok { color: #3ddc84; } .rel-resultado.ruim { color: #ff4d4d; }
.rel-sub { color: #9aa5b1; font-size: 14px; }
.rel-pontos { margin: 10px 0 16px; }
.rel-barra { height: 8px; border-radius: 4px; background: #2a3340; overflow: hidden; position: relative; }
.rel-barra i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; }
.rel-barra-rot { display: flex; justify-content: space-between; font-size: 12px; color: #9aa5b1; margin-top: 4px; }
.rel-corpo { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 18px; }
@media (max-width: 760px) { .rel-corpo { grid-template-columns: 1fr; } }
.rel-cartao h3 { margin: 0 0 8px; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: #ffb000; }
.rel-mapa { width: 100%; height: auto; display: block; border-radius: 8px; background: #3c3c3c; }
.rel-legenda { font-size: 12px; color: #9aa5b1; margin-top: 6px; display: flex; gap: 12px; flex-wrap: wrap; }
.rel-legenda span::before { content: ''; display: inline-block; width: 14px; height: 3px; margin-right: 5px;
  vertical-align: middle; background: var(--c); border-radius: 2px; }
.rel-tabela { width: 100%; border-collapse: collapse; font-size: 13px; }
.rel-tabela th { text-align: left; color: #9aa5b1; font-weight: 600; padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,.12); }
.rel-tabela td { padding: 5px 6px; border-bottom: 1px solid rgba(255,255,255,.06); vertical-align: top; }
.rel-tabela td.n { font-variant-numeric: tabular-nums; white-space: nowrap; }
.rel-num { display: inline-flex; width: 18px; height: 18px; border-radius: 50%; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; color: #111; background: var(--c); }
.rel-grav { color: var(--c); white-space: nowrap; }
.rel-vazio { color: #3ddc84; font-size: 14px; padding: 6px 0; }
.rel-hist { margin-top: 18px; }
.rel-hist .ok { color: #3ddc84; } .rel-hist .ruim { color: #ff4d4d; }
.rel-botoes { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
.rel-botoes button { background: #2a3340; color: #e9edf2; border: 1px solid rgba(255,255,255,.12); border-radius: 8px;
  padding: 9px 18px; font-size: 14px; cursor: pointer; }
.rel-botoes button:hover { background: #364151; }
.rel-botoes button.prim { background: #ffb000; color: #111; border-color: #ffb000; font-weight: 700; }
.rel-botoes button.prim:hover { background: #ffc53d; }
.rel-nota { font-size: 11px; color: #6c7783; margin-top: 12px; }
`;

let cssInjetado = false;
function injetarCss(): void {
  if (cssInjetado) return;
  cssInjetado = true;
  const s = document.createElement('style');
  s.dataset.modulo = 'relatorio';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function mmss(seg: number): string {
  const s = Math.max(0, Math.floor(seg));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function esc(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---------------------------------------------------------------------------
// Histórico

/** Últimas tentativas (mais recente primeiro). Vazio se o navegador não deixar ler. */
export function historicoProvas(): RegistroProva[] {
  try {
    const bruto = localStorage.getItem(CHAVE_HISTORICO);
    if (!bruto) return [];
    const lista = JSON.parse(bruto);
    return Array.isArray(lista) ? (lista as RegistroProva[]).slice(0, MAX_HISTORICO) : [];
  } catch {
    return [];
  }
}

const salvas = new WeakSet<Prova>();

function salvarNoHistorico(prova: Prova): void {
  if (salvas.has(prova) || !prova.iniciada) return;
  salvas.add(prova);
  const reg: RegistroProva = {
    data: new Date().toISOString(),
    aprovado: prova.aprovado,
    interrompida: prova.eliminado,
    pontos: prova.pontos,
    limite: LIMITE_PONTOS,
    duracao: prova.duracao,
    faltas: prova.faltas.length,
  };
  try {
    const lista = [reg, ...historicoProvas()].slice(0, MAX_HISTORICO);
    localStorage.setItem(CHAVE_HISTORICO, JSON.stringify(lista));
  } catch {
    /* modo privado / armazenamento bloqueado: segue sem histórico */
  }
}

// ---------------------------------------------------------------------------
// Mini-mapa

function desenharMapa(canvas: HTMLCanvasElement, prova: Prova, faltas: Falta[], img: HTMLImageElement | null): void {
  const W = img?.naturalWidth || PLANTA_W;
  const H = img?.naturalHeight || PLANTA_H;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const largura = canvas.clientWidth || 420;
  const altura = (largura * H) / W;
  canvas.width = Math.round(largura * dpr);
  canvas.height = Math.round(altura * dpr);
  const c = canvas.getContext('2d');
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const k = largura / W;
  // mundo (m) → planta (px) → canvas
  const X = (x: number) => (x / METROS_POR_PX + W / 2) * k;
  const Y = (z: number) => (z / METROS_POR_PX + H / 2) * k;

  c.clearRect(0, 0, largura, altura);
  if (img) {
    c.globalAlpha = 0.85;
    c.drawImage(img, 0, 0, largura, altura);
    c.globalAlpha = 1;
  } else {
    c.fillStyle = '#3c3c3c';
    c.fillRect(0, 0, largura, altura);
  }

  // Trajetória: azul, laranja onde passou do limite de velocidade.
  const tr = prova.trajetoria;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.lineWidth = 3;
  for (let i = 1; i < tr.length; i++) {
    const a = tr[i - 1], b = tr[i];
    c.strokeStyle = b.v > VELOCIDADE_MAXIMA ? '#ff8a00' : '#35a7ff';
    c.beginPath();
    c.moveTo(X(a.x), Y(a.z));
    c.lineTo(X(b.x), Y(b.z));
    c.stroke();
  }
  if (tr.length) {
    const ini = tr[0], fim = tr[tr.length - 1];
    c.fillStyle = '#3ddc84';
    c.beginPath();
    c.arc(X(ini.x), Y(ini.z), 5, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#ffffff';
    c.strokeStyle = '#111';
    c.lineWidth = 2;
    c.beginPath();
    c.rect(X(fim.x) - 4, Y(fim.z) - 4, 8, 8);
    c.fill();
    c.stroke();
  }

  // Faltas numeradas
  c.font = '700 11px system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  faltas.forEach((f, i) => {
    const x = X(f.posicao.x), y = Y(f.posicao.z);
    c.fillStyle = COR[f.gravidade];
    c.strokeStyle = '#111';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, 9, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.fillStyle = '#111';
    c.fillText(String(i + 1), x, y + 0.5);
  });
}

// ---------------------------------------------------------------------------

/** Mostra o resultado da prova num modal (e grava a tentativa no histórico). */
export function mostrarRelatorio(pai: HTMLElement, prova: Prova, opts: OpcoesRelatorio): void {
  injetarCss();
  salvarNoHistorico(prova);

  const aprovado = prova.aprovado;
  const interrompida = prova.eliminado;
  const pontos = prova.pontos;
  const faltas = [...prova.faltas];

  const fundo = document.createElement('div');
  fundo.className = 'rel-fundo';
  fundo.setAttribute('role', 'dialog');
  fundo.setAttribute('aria-modal', 'true');
  fundo.setAttribute('aria-label', 'Resultado da prova');

  const pct = Math.min(100, (pontos / LIMITE_PONTOS) * 100);
  const corBarra = pontos > LIMITE_PONTOS ? '#ff4d4d' : pontos > LIMITE_PONTOS * 0.6 ? '#ffb000' : '#3ddc84';
  const motivo = interrompida
    ? 'Prova interrompida pelo examinador.'
    : aprovado
      ? `Nota ${pontos} — dentro do limite de ${LIMITE_PONTOS} pontos.`
      : `Nota ${pontos} — acima do limite de ${LIMITE_PONTOS} pontos.`;

  const linhas = faltas
    .map((f, i) => {
      const cor = COR[f.gravidade];
      const pt = f.gravidade === 'eliminatoria' ? '—' : String(PONTOS[f.gravidade]);
      return `<tr style="--c:${cor}">
        <td><span class="rel-num">${i + 1}</span></td>
        <td class="n">${mmss(f.tempo - prova.tempoInicio)}</td>
        <td>${esc(f.descricao)}</td>
        <td class="rel-grav">${esc(ROTULO_GRAVIDADE[f.gravidade])}</td>
        <td class="n">${pt}</td>
      </tr>`;
    })
    .join('');

  const hist = historicoProvas();
  const linhasHist = hist
    .map((h) => {
      const d = new Date(h.data);
      const data = isNaN(d.getTime())
        ? '—'
        : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const res = h.aprovado ? '<span class="ok">Aprovado</span>' : `<span class="ruim">${h.interrompida ? 'Interrompida' : 'Reprovado'}</span>`;
      return `<tr><td class="n">${esc(data)}</td><td>${res}</td><td class="n">${h.pontos} / ${h.limite}</td><td class="n">${mmss(h.duracao)}</td><td class="n">${h.faltas}</td></tr>`;
    })
    .join('');

  fundo.innerHTML = `
    <div class="rel-cartao">
      <div class="rel-topo">
        <div class="rel-resultado ${aprovado ? 'ok' : 'ruim'}">${aprovado ? 'APROVADO' : 'REPROVADO'}</div>
        <div class="rel-sub">${esc(motivo)} Duração ${mmss(prova.duracao)}.</div>
      </div>
      <div class="rel-pontos">
        <div class="rel-barra"><i style="width:${pct}%;background:${corBarra}"></i></div>
        <div class="rel-barra-rot"><span>0</span><span>${pontos} pt</span><span>limite ${LIMITE_PONTOS}</span></div>
      </div>
      <div class="rel-corpo">
        <div>
          <h3>Trajeto</h3>
          <canvas class="rel-mapa"></canvas>
          <div class="rel-legenda">
            <span style="--c:#35a7ff">trajeto</span>
            <span style="--c:#ff8a00">acima de 30 km/h</span>
            <span style="--c:#ff8a65">faltas (números)</span>
          </div>
        </div>
        <div>
          <h3>Faltas</h3>
          ${
            faltas.length
              ? `<table class="rel-tabela"><thead><tr><th></th><th>Tempo</th><th>Falta</th><th>Natureza</th><th>Pt</th></tr></thead><tbody>${linhas}</tbody></table>`
              : '<div class="rel-vazio">Nenhuma falta. Excelente!</div>'
          }
        </div>
      </div>
      <div class="rel-hist">
        <h3>Últimas tentativas</h3>
        ${
          hist.length
            ? `<table class="rel-tabela"><thead><tr><th>Data</th><th>Resultado</th><th>Pontos</th><th>Duração</th><th>Faltas</th></tr></thead><tbody>${linhasHist}</tbody></table>`
            : '<div class="rel-sub">Histórico indisponível neste navegador.</div>'
        }
      </div>
      <div class="rel-nota">Pontuação conforme a Resolução CONTRAN nº 1.020/2025: leve 1, média 2, grave 4, gravíssima 6; aprovado com até ${LIMITE_PONTOS} pontos.</div>
      <div class="rel-botoes">
        <button type="button" data-acao="fechar">Fechar</button>
        <button type="button" class="prim" data-acao="nova">Nova prova</button>
      </div>
    </div>`;

  pai.appendChild(fundo);

  const canvas = fundo.querySelector<HTMLCanvasElement>('canvas.rel-mapa')!;
  let img: HTMLImageElement | null = null;
  const redesenhar = () => desenharMapa(canvas, prova, faltas, img && img.complete && img.naturalWidth ? img : null);
  requestAnimationFrame(redesenhar);
  const im = new Image();
  im.onload = () => {
    img = im;
    redesenhar();
  };
  im.src = opts.urlMapa;
  const aoRedimensionar = () => redesenhar();
  window.addEventListener('resize', aoRedimensionar);

  let fechado = false;
  const fechar = (depois: () => void) => {
    if (fechado) return;
    fechado = true;
    window.removeEventListener('resize', aoRedimensionar);
    window.removeEventListener('keydown', teclas, true);
    fundo.remove();
    depois();
  };
  const teclas = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      fechar(opts.onFechar);
    }
  };
  window.addEventListener('keydown', teclas, true);
  fundo.querySelector<HTMLButtonElement>('[data-acao="fechar"]')!.addEventListener('click', () => fechar(opts.onFechar));
  const botaoNova = fundo.querySelector<HTMLButtonElement>('[data-acao="nova"]')!;
  botaoNova.addEventListener('click', () => fechar(opts.onNovaProva));
  botaoNova.focus();
}
