import {
  Acao, BOTOES, descreverVinculo, EIXOS, Entrada, lerVinculo, NOMES_ACAO, Perfil, perfilPadrao, Vinculo,
} from './input';

const ehEixo = (a: Acao) => (EIXOS as readonly string[]).includes(a);

function instrucao(a: Acao, perfil: Perfil): string {
  const vol = perfil.tipo === 'volante';
  if (a === 'volante') return vol ? 'Gire o volante para a DIREITA e segure.' : 'Empurre o analógico de direção para a DIREITA e segure.';
  if (a === 'olhar') return 'Mova o eixo para a DIREITA e segure.';
  if (a === 'acelerador' || a === 'freio' || a === 'embreagem')
    return vol ? `Pise TODO no pedal de ${NOMES_ACAO[a].toLowerCase()} e segure.` : `Aperte TODO o gatilho/analógico do ${NOMES_ACAO[a].toLowerCase()} e segure.`;
  if (/^marcha[1-5R]$/.test(a)) return `Engate a ${NOMES_ACAO[a]} no câmbio H e segure.`;
  return `Aperte o botão para “${NOMES_ACAO[a]}”.`;
}

interface Captura {
  acao: Acao;
  gpIndex: number;
  base: { eixos: number[]; botoes: number[] };
  candidato: { tipo: 'eixo' | 'botao'; indice: number; valor: number; desde: number } | null;
  /** Fila do assistente completo (null = mudança avulsa). */
  fila: Acao[] | null;
  esperandoSoltar: boolean;
}

/**
 * Tela de controles (F2): mostra a tabela ação → eixo/botão de cada dispositivo,
 * com o valor ao vivo, e deixa trocar UM comando de cada vez (“Mudar”),
 * inverter um eixo ou limpar. O assistente completo continua disponível.
 */
export class Calibracao {
  private readonly el: HTMLElement;
  private readonly entrada: Entrada;
  private aberta = false;
  private selecionado = 0;
  private captura: Captura | null = null;
  private conteudo!: HTMLElement;
  private ultimoHtml = '';
  onFechar: () => void = () => {};

  constructor(entrada: Entrada, pai: HTMLElement) {
    this.entrada = entrada;
    this.el = document.createElement('div');
    this.el.className = 'painel calibracao oculto';
    pai.appendChild(this.el);
    this.conteudo = document.createElement('div');
    this.el.appendChild(this.conteudo);
    window.addEventListener('keydown', (e) => {
      if (this.aberta && this.captura && e.code === 'Escape') {
        this.captura = null;
        e.preventDefault();
      }
    });
  }

  get estaAberta(): boolean {
    return this.aberta;
  }

  abrir(): void {
    this.aberta = true;
    this.entrada.pausado = true;
    this.el.classList.remove('oculto');
    const loop = () => {
      if (!this.aberta) return;
      this.atualizar();
      requestAnimationFrame(loop);
    };
    loop();
  }

  fechar(): void {
    this.aberta = false;
    this.captura = null;
    this.entrada.pausado = false;
    this.el.classList.add('oculto');
    this.onFechar();
  }

  private gp(i: number): Gamepad | null {
    return navigator.getGamepads?.()[i] ?? null;
  }

  private snapshot(gp: Gamepad) {
    return { eixos: [...gp.axes], botoes: gp.buttons.map((b) => b.value || (b.pressed ? 1 : 0)) };
  }

  private iniciarCaptura(gp: Gamepad, acao: Acao, fila: Acao[] | null = null): void {
    this.captura = { acao, gpIndex: gp.index, base: this.snapshot(gp), candidato: null, fila, esperandoSoltar: false };
  }

  private gravar(gp: Gamepad, acao: Acao, v: Vinculo | undefined): void {
    const p = this.entrada.perfil(gp);
    const vinculos = { ...p.vinculos };
    if (v) vinculos[acao] = v;
    else delete vinculos[acao];
    this.entrada.definirPerfil({ ...p, vinculos, calibrado: true });
  }

  private proximo(gp: Gamepad): void {
    const c = this.captura!;
    if (c.fila && c.fila.length) {
      const a = c.fila.shift()!;
      this.captura = { ...c, acao: a, candidato: null, esperandoSoltar: true };
    } else {
      this.captura = null;
    }
    void gp;
  }

  /** Detecta o controle mexido e grava o vínculo. */
  private passoCaptura(gp: Gamepad): void {
    const c = this.captura!;
    const agora = this.snapshot(gp);
    const t = performance.now() / 1000;

    if (c.esperandoSoltar) {
      const mexendo =
        agora.eixos.some((v, i) => Math.abs(v - c.base.eixos[i]) > 0.25) ||
        agora.botoes.some((v, i) => v > 0.5 && c.base.botoes[i] <= 0.5);
      if (mexendo) return;
      c.esperandoSoltar = false;
    }

    if (!ehEixo(c.acao)) {
      const b = agora.botoes.findIndex((v, i) => v > 0.5 && c.base.botoes[i] <= 0.5);
      if (b >= 0) {
        this.gravar(gp, c.acao, { tipo: 'botao', indice: b });
        this.proximo(gp);
        return;
      }
      // Direcional que aparece como eixo (hat): vira “eixo como botão”.
      const e = agora.eixos.findIndex((v, i) => Math.abs(v - c.base.eixos[i]) > 0.3);
      if (e >= 0) {
        if (!c.candidato || c.candidato.indice !== e || Math.abs(c.candidato.valor - agora.eixos[e]) > 0.02) {
          c.candidato = { tipo: 'eixo', indice: e, valor: agora.eixos[e], desde: t };
        } else if (t - c.candidato.desde > 0.3) {
          this.gravar(gp, c.acao, { tipo: 'eixoBotao', indice: e, alvo: agora.eixos[e] });
          this.proximo(gp);
        }
      }
      return;
    }

    // Eixo: maior variação em relação ao repouso (também aceita gatilho analógico como pedal).
    let melhor: { tipo: 'eixo' | 'botao'; indice: number; valor: number; delta: number } | null = null;
    agora.eixos.forEach((v, i) => {
      const d = Math.abs(v - c.base.eixos[i]);
      if (d > 0.4 && (!melhor || d > melhor.delta)) melhor = { tipo: 'eixo', indice: i, valor: v, delta: d };
    });
    if (c.acao !== 'volante' && c.acao !== 'olhar') {
      agora.botoes.forEach((v, i) => {
        const d = v - c.base.botoes[i];
        if (d > 0.4 && (!melhor || d > melhor.delta)) melhor = { tipo: 'botao', indice: i, valor: v, delta: d };
      });
    }
    const m = melhor as { tipo: 'eixo' | 'botao'; indice: number; valor: number; delta: number } | null;
    if (!m) { c.candidato = null; return; }
    if (!c.candidato || c.candidato.indice !== m.indice || c.candidato.tipo !== m.tipo || Math.abs(c.candidato.valor - m.valor) > 0.03) {
      c.candidato = { tipo: m.tipo, indice: m.indice, valor: m.valor, desde: t };
      return;
    }
    if (t - c.candidato.desde < 0.5) return;

    if (m.tipo === 'botao') {
      this.gravar(gp, c.acao, { tipo: 'botao', indice: m.indice });
    } else if (c.acao === 'volante' || c.acao === 'olhar') {
      // centro = onde estava; direita = onde foi
      this.gravar(gp, c.acao, { tipo: 'eixo', indice: m.indice, repouso: c.base.eixos[m.indice], fim: m.valor });
    } else {
      this.gravar(gp, c.acao, { tipo: 'eixo', indice: m.indice, repouso: c.base.eixos[m.indice], fim: m.valor });
    }
    c.esperandoSoltar = true;
    this.proximo(gp);
  }

  private atualizar(): void {
    const gps = this.entrada.gamepads();
    if (this.captura) {
      const gp = this.gp(this.captura.gpIndex);
      if (gp) this.passoCaptura(gp);
      else this.captura = null;
    }

    let html = '<h2>Controles</h2>';
    if (gps.length === 0) {
      html += `<p>Nenhum controle detectado. Conecte o controle ou o G29 e <b>aperte qualquer botão</b> —
        o navegador só mostra o dispositivo depois de uma interação.</p>
        <p class="dica">G29 no PC: chave na posição <b>PS3</b>. O G29 já vem mapeado; aqui você só ajusta o que quiser.</p>`;
      html += `<div class="botoes"><button data-acao="fechar">Fechar (F2)</button></div>`;
      this.render(html);
      return;
    }
    if (!gps.some((g) => g.index === this.selecionado)) this.selecionado = gps[0].index;

    html += '<div class="abas">' + gps.map((g) =>
      `<button class="${g.index === this.selecionado ? 'ativa' : ''}" data-acao="sel" data-gp="${g.index}">${g.id.replace(/\(.*\)/, '').trim().slice(0, 40) || 'Dispositivo ' + g.index}</button>`,
    ).join('') + '</div>';

    const gp = gps.find((g) => g.index === this.selecionado)!;
    const p = this.entrada.perfil(gp);
    html += `<div class="sub">${gp.id} · ${p.tipo === 'volante' ? 'Volante' : 'Controle'} · ${gp.axes.length} eixos, ${gp.buttons.length} botões</div>`;

    if (this.captura) {
      html += `<div class="assistente"><div class="instrucao">${NOMES_ACAO[this.captura.acao]}: ${instrucao(this.captura.acao, p)}</div>
        <div class="msg">${this.captura.esperandoSoltar ? 'Solte…' : this.captura.candidato ? 'Segure…' : 'Aguardando…'}</div>
        <div class="botoes">${this.captura.fila ? '<button data-acao="pular">Pular</button>' : ''}<button data-acao="cancelar">Cancelar (Esc)</button></div></div>`;
    }

    html += '<table class="mapa-controles"><thead><tr><th>Ação</th><th>Vínculo</th><th>Valor</th><th></th></tr></thead><tbody>';
    for (const a of [...EIXOS, ...BOTOES] as Acao[]) {
      const v = p.vinculos[a];
      const val = v ? lerVinculo(gp, v) : 0;
      const eixo = ehEixo(a);
      const pct = eixo && (a === 'volante' || a === 'olhar') ? ((Math.max(-1, Math.min(1, val)) + 1) / 2) * 100 : Math.max(0, Math.min(1, val)) * 100;
      html += `<tr class="${this.captura?.acao === a ? 'capturando' : ''}">
        <td>${NOMES_ACAO[a]}</td>
        <td class="vinc">${descreverVinculo(v)}</td>
        <td><div class="medidor ${eixo && (a === 'volante' || a === 'olhar') ? 'centro' : ''}"><i data-val="${a}" style="width:${pct}%"></i></div></td>
        <td class="acoes">
          <button data-acao="mudar" data-a="${a}">Mudar</button>
          ${v?.tipo === 'eixo' ? `<button data-acao="inverter" data-a="${a}" title="Inverter eixo">⇄</button>` : ''}
          ${v ? `<button data-acao="limpar" data-a="${a}" title="Remover">✕</button>` : ''}
        </td></tr>`;
    }
    html += '</tbody></table>';
    html += `<div class="botoes">
      <button data-acao="assistente">Assistente completo</button>
      <button data-acao="tipo">Tratar como ${p.tipo === 'volante' ? 'controle' : 'volante'}</button>
      <button data-acao="padrao">Restaurar padrão</button>
      <button data-acao="fechar">Fechar (F2)</button>
    </div>
    <p class="dica">Teclado: W/S acelerador/freio · A/D direção · Shift embreagem · 1–5/R/N marchas · Espaço freio de mão · I partida · Q/E setas · L farol · K pisca-alerta · C cinto · Z/X olhar · V câmera.</p>`;
    this.render(html);

    // Valores ao vivo sem refazer o HTML (para os botões continuarem clicáveis).
    this.conteudo.querySelectorAll<HTMLElement>('[data-val]').forEach((el) => {
      const a = el.dataset.val as Acao;
      const v = p.vinculos[a];
      const val = v ? lerVinculo(gp, v) : 0;
      const centro = a === 'volante' || a === 'olhar';
      el.style.width = `${centro ? ((Math.max(-1, Math.min(1, val)) + 1) / 2) * 100 : Math.max(0, Math.min(1, val)) * 100}%`;
    });
  }

  private render(html: string): void {
    // Ignora as larguras dos medidores na comparação (mudam todo frame).
    const chave = html.replace(/style="width:[^"]*"/g, '');
    if (chave === this.ultimoHtml) return;
    this.ultimoHtml = chave;
    this.conteudo.innerHTML = html;
    this.conteudo.querySelectorAll('button').forEach((b) => {
      b.onclick = () => this.clique(b.dataset.acao!, b.dataset.a as Acao | undefined, b.dataset.gp);
    });
  }

  private clique(acao: string, a?: Acao, gpStr?: string): void {
    if (acao === 'sel' && gpStr !== undefined) { this.selecionado = Number(gpStr); this.captura = null; return; }
    if (acao === 'fechar') { this.fechar(); return; }
    if (acao === 'cancelar') { this.captura = null; return; }
    const gp = this.gp(this.selecionado);
    if (!gp) return;
    const p = this.entrada.perfil(gp);
    switch (acao) {
      case 'mudar':
        if (a) this.iniciarCaptura(gp, a);
        break;
      case 'inverter': {
        const v = a && p.vinculos[a];
        if (a && v && v.tipo === 'eixo') {
          // volante/olhar: espelha em torno do centro; pedais: troca repouso e fim
          const nv = a === 'volante' || a === 'olhar'
            ? { ...v, fim: 2 * v.repouso - v.fim }
            : { ...v, repouso: v.fim, fim: v.repouso };
          this.gravar(gp, a, nv);
        }
        break;
      }
      case 'limpar':
        if (a) this.gravar(gp, a, undefined);
        break;
      case 'assistente': {
        const todas = [...EIXOS, ...BOTOES] as Acao[];
        this.iniciarCaptura(gp, todas[0], todas.slice(1));
        break;
      }
      case 'pular':
        if (this.captura) this.proximo(gp);
        break;
      case 'tipo':
        this.entrada.definirPerfil({ ...p, tipo: p.tipo === 'volante' ? 'controle' : 'volante' });
        break;
      case 'padrao':
        this.entrada.definirPerfil(perfilPadrao(gp));
        break;
    }
    this.ultimoHtml = '';
  }
}
