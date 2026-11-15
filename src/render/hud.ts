import { Prova } from '../exam/exam';
import { LIMITE_PONTOS, PONTOS } from '../exam/regras';
import { EstadoEntrada } from '../input/input';
import { Veiculo } from '../sim/vehicle';

const nomeMarcha = (m: number) => (m === -1 ? 'R' : m === 0 ? 'N' : String(m));

/** Painel de instrumentos + status da prova, em HTML por cima do canvas. */
export class Hud {
  private readonly el: HTMLElement;
  private readonly refs: Record<string, HTMLElement> = {};
  private ultimaMsg = 0;

  constructor(pai: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="painel-inst">
        <div class="vel"><span data-r="vel">0</span><small>km/h</small></div>
        <div class="rpm"><div class="rpm-barra"><i data-r="rpmbar"></i><b class="red"></b></div><span data-r="rpm">0</span> rpm</div>
        <div class="marcha" data-r="marcha">N</div>
        <div class="pedais">
          <div><label>E</label><div class="pb"><i data-r="emb"></i></div></div>
          <div><label>F</label><div class="pb"><i data-r="freio"></i></div></div>
          <div><label>A</label><div class="pb"><i data-r="acel"></i></div></div>
        </div>
        <div class="luzes">
          <span data-r="setaE" class="luz seta">◀</span>
          <span data-r="motor" class="luz">MOTOR</span>
          <span data-r="fm" class="luz">(P)</span>
          <span data-r="cinto" class="luz">CINTO</span>
          <span data-r="setaD" class="luz seta">▶</span>
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
  }

  avisoCalibracao(texto: string | null): void {
    const e = this.refs.calib;
    e.classList.toggle('oculto', !texto);
    if (texto) e.textContent = texto;
  }

  atualizar(v: Veiculo, ent: EstadoEntrada, prova: Prova, tempo: number, piscando: boolean, camera: string): void {
    const r = this.refs;
    const tr = v.trem;
    r.vel.textContent = Math.abs(v.velocidadeLongitudinal() * 3.6).toFixed(0);
    const rpm = Math.max(0, tr.rpm);
    r.rpm.textContent = (Math.round(rpm / 50) * 50).toString();
    r.rpmbar.style.width = `${Math.min(100, (rpm / 7000) * 100)}%`;
    const engatada = tr.marchaEngatada;
    r.marcha.textContent = nomeMarcha(engatada);
    r.marcha.classList.toggle('arranhando', tr.arranhando);
    r.emb.style.height = `${ent.embreagem * 100}%`;
    r.freio.style.height = `${ent.freio * 100}%`;
    r.acel.style.height = `${ent.acelerador * 100}%`;
    r.setaE.classList.toggle('on', ent.seta === 'esquerda' && piscando);
    r.setaD.classList.toggle('on', ent.seta === 'direita' && piscando);
    r.motor.classList.toggle('alerta', !tr.ligado);
    r.motor.textContent = tr.ligado ? 'MOTOR' : tr.ignicao ? 'MOTOR (ignição)' : 'MOTOR OFF';
    r.fm.classList.toggle('alerta', ent.freioDeMao);
    r.cinto.classList.toggle('alerta', !ent.cinto);
    const pedida = ent.marcha !== engatada ? ` · pedida: ${nomeMarcha(ent.marcha)}${tr.arranhando ? ' (pise na embreagem!)' : ''}` : '';
    r.extra.textContent = `câmera: ${camera}${pedida}${tr.patinando ? ' · embreagem patinando' : ''}`;

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

    // Mensagens novas viram toasts
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
