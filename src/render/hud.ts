import { Prova } from '../exam/exam';
import { LIMITE_PONTOS, PONTOS } from '../exam/regras';
import { EstadoEntrada } from '../input/input';
import { Veiculo } from '../sim/vehicle';

const nomeMarcha = (m: number) => (m === -1 ? 'R' : m === 0 ? 'N' : String(m));

/** Mostrador analógico desenhado em canvas. */
class Mostrador {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tam: number;
  private ponteiro = 0;

  constructor(
    private readonly max: number,
    private readonly passoNumero: number,
    private readonly divisor: number,
    private readonly rotulo: string,
    private readonly faixaVermelha: number | null,
    tam = 150,
  ) {
    this.tam = tam;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas = document.createElement('canvas');
    this.canvas.width = tam * dpr;
    this.canvas.height = tam * dpr;
    this.canvas.style.width = `${tam}px`;
    this.canvas.style.height = `${tam}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
  }

  desenhar(valor: number, dt: number, centro: string): void {
    // Ponteiro com um pouco de inércia, como o de verdade.
    this.ponteiro += (Math.max(0, Math.min(this.max * 1.02, valor)) - this.ponteiro) * Math.min(1, dt * 14);
    const c = this.ctx;
    const t = this.tam;
    const r = t / 2 - 6;
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    const ang = (v: number) => a0 + (a1 - a0) * (v / this.max);
    c.clearRect(0, 0, t, t);
    c.save();
    c.translate(t / 2, t / 2);

    // Fundo
    const g = c.createRadialGradient(0, 0, r * 0.2, 0, 0, r);
    g.addColorStop(0, '#1a1e24');
    g.addColorStop(1, '#0b0d10');
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, r + 4, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#3a414b';
    c.lineWidth = 3;
    c.stroke();

    // Faixa vermelha
    if (this.faixaVermelha !== null) {
      c.strokeStyle = '#d33';
      c.lineWidth = 7;
      c.beginPath();
      c.arc(0, 0, r - 6, ang(this.faixaVermelha), ang(this.max));
      c.stroke();
    }

    // Marcas e números
    const passoMenor = this.passoNumero / 5;
    for (let v = 0; v <= this.max + 1e-6; v += passoMenor) {
      const a = ang(v);
      const maior = Math.abs(v / this.passoNumero - Math.round(v / this.passoNumero)) < 1e-6;
      c.strokeStyle = maior ? '#e8ecf0' : '#8b95a1';
      c.lineWidth = maior ? 2.5 : 1.2;
      c.beginPath();
      c.moveTo(Math.cos(a) * (r - (maior ? 14 : 9)), Math.sin(a) * (r - (maior ? 14 : 9)));
      c.lineTo(Math.cos(a) * (r - 2), Math.sin(a) * (r - 2));
      c.stroke();
      if (maior) {
        c.fillStyle = '#e8ecf0';
        c.font = `600 ${t * 0.075}px system-ui, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(Math.round(v / this.divisor)), Math.cos(a) * (r - 27), Math.sin(a) * (r - 27));
      }
    }
    c.fillStyle = '#8b95a1';
    c.font = `500 ${t * 0.06}px system-ui, sans-serif`;
    c.textAlign = 'center';
    c.fillText(this.rotulo, 0, r * 0.38);
    c.fillStyle = '#ffb000';
    c.font = `700 ${t * 0.12}px system-ui, sans-serif`;
    c.fillText(centro, 0, r * 0.62);

    // Ponteiro
    const a = ang(this.ponteiro);
    c.strokeStyle = '#ff5a2a';
    c.lineWidth = 3.5;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(-Math.cos(a) * 12, -Math.sin(a) * 12);
    c.lineTo(Math.cos(a) * (r - 12), Math.sin(a) * (r - 12));
    c.stroke();
    c.fillStyle = '#2a2f36';
    c.beginPath();
    c.arc(0, 0, 9, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }
}

type Luz = 'setaE' | 'farol' | 'alerta' | 'cinto' | 'bateria' | 'oleo' | 'injecao' | 'freioMao' | 'setaD';
const LUZES: { id: Luz; icone: string; cor: string; titulo: string }[] = [
  { id: 'setaE', icone: '◀', cor: '#3ddc84', titulo: 'Seta esquerda' },
  { id: 'farol', icone: '◐', cor: '#3ddc84', titulo: 'Farol' },
  { id: 'alerta', icone: '⚠', cor: '#ff4d4d', titulo: 'Pisca-alerta' },
  { id: 'cinto', icone: '⛑', cor: '#ff4d4d', titulo: 'Cinto' },
  { id: 'bateria', icone: '▭', cor: '#ff4d4d', titulo: 'Bateria / ignição' },
  { id: 'oleo', icone: '♨', cor: '#ff4d4d', titulo: 'Pressão do óleo' },
  { id: 'injecao', icone: '⚙', cor: '#ffb000', titulo: 'Injeção' },
  { id: 'freioMao', icone: '(P)', cor: '#ff4d4d', titulo: 'Freio de mão' },
  { id: 'setaD', icone: '▶', cor: '#3ddc84', titulo: 'Seta direita' },
];

/** Painel de instrumentos + status da prova, em HTML por cima do canvas. */
export class Hud {
  private readonly el: HTMLElement;
  private readonly refs: Record<string, HTMLElement> = {};
  private readonly luzes = new Map<Luz, HTMLElement>();
  private readonly conta: Mostrador;
  private readonly velo: Mostrador;
  private ultimaMsg = 0;

  constructor(pai: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="cluster">
        <div class="mostradores" data-r="most"></div>
        <div class="luzes" data-r="luzes"></div>
        <div class="pedais">
          <div><label>E</label><div class="pb"><i data-r="emb"></i></div></div>
          <div><label>F</label><div class="pb"><i data-r="freio"></i></div></div>
          <div><label>A</label><div class="pb"><i data-r="acel"></i></div></div>
        </div>
        <div class="extra" data-r="extra"></div>
      </div>
      <div class="prova">
        <div class="titulo">Prova prática</div>
        <div data-r="status"></div>
        <div data-r="pontos"></div>
        <div data-r="baliza"></div>
        <ol data-r="faltas"></ol>
      </div>
      <div class="toasts" data-r="toasts"></div>
      <div class="aviso-calib oculto" data-r="calib"></div>
    `;
    pai.appendChild(this.el);
    this.el.querySelectorAll<HTMLElement>('[data-r]').forEach((e) => (this.refs[e.dataset.r!] = e));
    this.conta = new Mostrador(8000, 1000, 1000, 'RPM ×1000', 6500);
    this.velo = new Mostrador(180, 20, 1, 'km/h', null);
    this.refs.most.append(this.conta.canvas, this.velo.canvas);
    for (const l of LUZES) {
      const s = document.createElement('span');
      s.className = 'luz';
      s.textContent = l.icone;
      s.title = l.titulo;
      s.style.setProperty('--cor', l.cor);
      this.refs.luzes.appendChild(s);
      this.luzes.set(l.id, s);
    }
  }

  avisoCalibracao(texto: string | null): void {
    const e = this.refs.calib;
    e.classList.toggle('oculto', !texto);
    if (texto) e.textContent = texto;
  }

  atualizar(v: Veiculo, ent: EstadoEntrada, prova: Prova, tempo: number, piscando: boolean, camera: string, dt: number): void {
    const r = this.refs;
    const tr = v.trem;
    const kmh = Math.abs(v.velocidadeLongitudinal() * 3.6);
    this.conta.desenhar(Math.max(0, tr.rpm), dt, nomeMarcha(tr.marchaEngatada));
    this.velo.desenhar(kmh, dt, kmh.toFixed(0));
    r.emb.style.height = `${ent.embreagem * 100}%`;
    r.freio.style.height = `${ent.freio * 100}%`;
    r.acel.style.height = `${ent.acelerador * 100}%`;

    const ign = tr.ignicao || tr.ligado;
    const lig = (id: Luz, on: boolean) => this.luzes.get(id)!.classList.toggle('on', on);
    const piscaE = (ent.seta === 'esquerda' || ent.alerta) && piscando;
    const piscaD = (ent.seta === 'direita' || ent.alerta) && piscando;
    lig('setaE', piscaE);
    lig('setaD', piscaD);
    lig('alerta', ent.alerta && piscando);
    lig('farol', ent.farol);
    lig('cinto', !ent.cinto && (ign || kmh > 1));
    lig('bateria', ign && !tr.ligado);
    lig('oleo', ign && !tr.ligado);
    lig('injecao', ign && !tr.ligado);
    lig('freioMao', ent.freioDeMao);

    const pedida = ent.marcha !== tr.marchaEngatada ? `pedida: ${nomeMarcha(ent.marcha)}${tr.arranhando ? ' — pise na embreagem!' : ''}` : '';
    r.extra.textContent = [`câmera: ${camera}`, pedida, tr.patinando ? 'embreagem patinando' : ''].filter(Boolean).join(' · ');
    r.extra.classList.toggle('alerta', tr.arranhando);

    // Prova
    if (!prova.iniciada) {
      r.status.textContent = 'Dê a partida para iniciar a prova';
    } else if (prova.encerrada) {
      r.status.innerHTML = prova.aprovado ? '<b class="ok">APROVADO</b>' : '<b class="ruim">REPROVADO</b>';
    } else {
      const t = tempo - prova.tempoInicio;
      r.status.textContent = `Em andamento · ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    }
    r.pontos.textContent = `Pontos: ${prova.pontos} / ${LIMITE_PONTOS}${prova.eliminado ? ' · ELIMINADO' : ''}`;
    if (prova.balizaConcluida !== null) r.baliza.textContent = `Baliza: concluída em ${prova.balizaConcluida.toFixed(0)} s`;
    else if (prova.balizaInicio !== null) r.baliza.textContent = `Baliza: ${(tempo - prova.balizaInicio).toFixed(0)} s`;
    else r.baliza.textContent = '';
    const html = prova.faltas
      .map((f) => `<li class="${f.gravidade}">${f.descricao} <small>${f.gravidade === 'eliminatoria' ? 'elim.' : `${f.gravidade} ${PONTOS[f.gravidade]}pt`}</small></li>`)
      .join('');
    if (r.faltas.innerHTML !== html) r.faltas.innerHTML = html;

    while (this.ultimaMsg < prova.mensagens.length) {
      const m = prova.mensagens[this.ultimaMsg++];
      const d = document.createElement('div');
      d.className = `toast ${m.tipo}`;
      d.textContent = m.texto;
      r.toasts.appendChild(d);
      setTimeout(() => d.remove(), 4500);
    }
  }

  reiniciar(): void {
    this.ultimaMsg = 0;
    this.refs.toasts.innerHTML = '';
  }
}
