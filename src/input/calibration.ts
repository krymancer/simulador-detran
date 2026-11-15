import { Acao, AcaoBotao, BOTOES, Entrada, NOMES_ACAO, Perfil, perfilPadrao, Vinculo } from './input';

type Passo =
  | { tipo: 'volante'; lado: 'esq' | 'dir' }
  | { tipo: 'pedal'; acao: 'acelerador' | 'freio' | 'embreagem' }
  | { tipo: 'botao'; acao: AcaoBotao };

function passosPara(perfil: Perfil): Passo[] {
  const p: Passo[] = [
    { tipo: 'volante', lado: 'esq' },
    { tipo: 'volante', lado: 'dir' },
    { tipo: 'pedal', acao: 'acelerador' },
    { tipo: 'pedal', acao: 'freio' },
    { tipo: 'pedal', acao: 'embreagem' },
  ];
  const botoes = perfil.tipo === 'volante' ? BOTOES : BOTOES.filter((b) => !/^marcha[1-5R]$/.test(b));
  for (const b of botoes) p.push({ tipo: 'botao', acao: b });
  return p;
}

function textoPasso(passo: Passo, perfil: Perfil): string {
  const vol = perfil.tipo === 'volante';
  switch (passo.tipo) {
    case 'volante':
      return vol
        ? `Gire o volante TODO para a ${passo.lado === 'esq' ? 'ESQUERDA' : 'DIREITA'} e segure.`
        : `Empurre o analógico de direção TODO para a ${passo.lado === 'esq' ? 'ESQUERDA' : 'DIREITA'} e segure.`;
    case 'pedal':
      return vol
        ? `Pise TODO no pedal de ${NOMES_ACAO[passo.acao].toLowerCase()} e segure.`
        : `Aperte/empurre TODO o controle que vai ser o ${NOMES_ACAO[passo.acao].toLowerCase()} e segure (gatilho ou analógico).`;
    case 'botao':
      if (/^marcha[1-5R]$/.test(passo.acao)) return `Câmbio H: engate a ${NOMES_ACAO[passo.acao]} e segure. (Pule se não tiver câmbio H.)`;
      return `Aperte o botão para: ${NOMES_ACAO[passo.acao]}.`;
  }
}

/**
 * Tela de calibração: lista dispositivos, mostra os valores brutos e conduz o
 * assistente que descobre qual eixo/botão é cada comando.
 */
export class Calibracao {
  private readonly el: HTMLElement;
  private readonly entrada: Entrada;
  private aberta = false;
  private assistente: {
    gpIndex: number;
    perfil: Perfil;
    passos: Passo[];
    i: number;
    base: { eixos: number[]; botoes: number[] };
    candidato: { tipo: 'eixo' | 'botao'; indice: number; valor: number; desde: number } | null;
    esperandoSoltar: boolean;
    volEsq: { indice: number; valor: number } | null;
    msg: string;
  } | null = null;
  onFechar: () => void = () => {};

  constructor(entrada: Entrada, pai: HTMLElement) {
    this.entrada = entrada;
    this.el = document.createElement('div');
    this.el.className = 'painel calibracao oculto';
    pai.appendChild(this.el);
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
    this.assistente = null;
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

  private iniciarAssistente(gp: Gamepad): void {
    const perfil: Perfil = { ...perfilPadrao(gp), vinculos: {}, calibrado: false };
    perfil.tipo = this.entrada.perfil(gp).tipo;
    this.assistente = {
      gpIndex: gp.index,
      perfil,
      passos: passosPara(perfil),
      i: 0,
      base: this.snapshot(gp),
      candidato: null,
      esperandoSoltar: false,
      volEsq: null,
      msg: '',
    };
  }

  private avancar(gp: Gamepad): void {
    const a = this.assistente!;
    a.i++;
    a.candidato = null;
    a.esperandoSoltar = true;
    if (a.i >= a.passos.length) {
      a.perfil.calibrado = true;
      this.entrada.definirPerfil(a.perfil);
      this.assistente = null;
      return;
    }
    void gp;
  }

  private vincular(acao: Acao, v: Vinculo): void {
    this.assistente!.perfil.vinculos[acao] = v;
  }

  private passoAssistente(gp: Gamepad): void {
    const a = this.assistente!;
    const agora = this.snapshot(gp);
    const passo = a.passos[a.i];
    const t = performance.now() / 1000;

    if (a.esperandoSoltar) {
      // Espera tudo voltar ao repouso antes do próximo passo.
      const mexendo =
        agora.eixos.some((v, i) => Math.abs(v - a.base.eixos[i]) > 0.2) ||
        agora.botoes.some((v, i) => v > 0.5 && a.base.botoes[i] <= 0.5);
      if (passo?.tipo === 'volante' && passo.lado === 'dir') {
        a.esperandoSoltar = false; // da esquerda direto para a direita
      } else if (!mexendo) {
        a.esperandoSoltar = false;
      } else {
        a.msg = 'Solte…';
        return;
      }
    }
    a.msg = '';

    if (passo.tipo === 'botao') {
      const usados = new Set(
        Object.values(a.perfil.vinculos).filter((v): v is Extract<Vinculo, { tipo: 'botao' }> => v?.tipo === 'botao').map((v) => v.indice),
      );
      const idx = agora.botoes.findIndex((v, i) => v > 0.5 && a.base.botoes[i] <= 0.5 && !usados.has(i));
      if (idx >= 0) {
        this.vincular(passo.acao, { tipo: 'botao', indice: idx });
        this.avancar(gp);
      }
      return;
    }

    // Eixos (volante/pedais): maior variação em relação ao repouso.
    let melhor: { tipo: 'eixo' | 'botao'; indice: number; valor: number; delta: number } | null = null;
    agora.eixos.forEach((v, i) => {
      if (passo.tipo === 'volante' && passo.lado === 'dir' && a.volEsq && i !== a.volEsq.indice) return;
      const d = Math.abs(v - a.base.eixos[i]);
      if (d > 0.4 && (!melhor || d > melhor.delta)) melhor = { tipo: 'eixo', indice: i, valor: v, delta: d };
    });
    if (passo.tipo === 'pedal') {
      agora.botoes.forEach((v, i) => {
        const d = v - a.base.botoes[i];
        if (d > 0.4 && (!melhor || d > melhor.delta)) melhor = { tipo: 'botao', indice: i, valor: v, delta: d };
      });
    }
    const m = melhor as { tipo: 'eixo' | 'botao'; indice: number; valor: number; delta: number } | null;
    if (!m) {
      a.candidato = null;
      return;
    }
    if (!a.candidato || a.candidato.indice !== m.indice || a.candidato.tipo !== m.tipo || Math.abs(a.candidato.valor - m.valor) > 0.03) {
      a.candidato = { tipo: m.tipo, indice: m.indice, valor: m.valor, desde: t };
      return;
    }
    a.msg = 'Segure…';
    if (t - a.candidato.desde < 0.6) return;

    // Aceito
    if (passo.tipo === 'volante') {
      if (passo.lado === 'esq') {
        a.volEsq = { indice: m.indice, valor: m.valor };
      } else if (a.volEsq) {
        const centro = (a.volEsq.valor + m.valor) / 2;
        this.vincular('volante', { tipo: 'eixo', indice: m.indice, repouso: centro, fim: m.valor });
      }
    } else if (m.tipo === 'eixo') {
      this.vincular(passo.acao, { tipo: 'eixo', indice: m.indice, repouso: a.base.eixos[m.indice], fim: m.valor });
    } else {
      this.vincular(passo.acao, { tipo: 'botao', indice: m.indice });
    }
    this.avancar(gp);
  }

  private atualizar(): void {
    const gps = this.entrada.gamepads();
    let html = '<h2>Controles e volante</h2>';

    if (this.assistente) {
      const a = this.assistente;
      const gp = this.gp(a.gpIndex);
      if (!gp) {
        this.assistente = null;
      } else {
        this.passoAssistente(gp);
        if (this.assistente) {
          const passo = a.passos[a.i];
          html += `<div class="assistente">
            <div class="passo">Passo ${a.i + 1} de ${a.passos.length}</div>
            <div class="instrucao">${textoPasso(passo, a.perfil)}</div>
            <div class="msg">${a.msg}</div>
            <div class="botoes">
              ${passo.tipo === 'botao' || passo.tipo === 'pedal' ? '<button data-acao="pular">Pular</button>' : ''}
              <button data-acao="cancelar">Cancelar</button>
            </div>
          </div>`;
          this.render(html, this.monitor(gp));
          return;
        }
      }
    }

    if (gps.length === 0) {
      html += `<p>Nenhum controle detectado. Conecte o controle ou o G29 e <b>aperte qualquer botão</b> —
        o navegador só mostra o dispositivo depois de uma interação.</p>
        <p class="dica">G29 no PC: chave do volante na posição <b>PS3</b>. No Linux, o driver <code>hid-logitech</code> já cuida do resto.</p>`;
    }
    for (const gp of gps) {
      const p = this.entrada.perfil(gp);
      const vinc = Object.entries(p.vinculos)
        .map(([k, v]) => `<span class="tag">${NOMES_ACAO[k as Acao]}: ${v!.tipo === 'eixo' ? `eixo ${v!.indice}` : `botão ${v!.indice}`}</span>`)
        .join(' ');
      html += `<div class="dispositivo">
        <div><b>${gp.id}</b></div>
        <div class="sub">${p.tipo === 'volante' ? 'Volante' : 'Controle'} · mapping: ${gp.mapping || 'não-padrão'} ·
          ${p.calibrado ? '<span class="ok">calibrado</span>' : '<span class="aviso">precisa calibrar</span>'}</div>
        <div class="vinculos">${vinc}</div>
        <div class="botoes">
          <button data-acao="calibrar" data-gp="${gp.index}">Calibrar</button>
          <button data-acao="tipo" data-gp="${gp.index}">Tratar como ${p.tipo === 'volante' ? 'controle' : 'volante'}</button>
          <button data-acao="padrao" data-gp="${gp.index}">Restaurar padrão</button>
        </div>
      </div>`;
    }
    html += `<div class="botoes"><button data-acao="fechar">Fechar (F2)</button></div>`;
    this.render(html, gps.map((g) => `<div class="sub">${g.id}</div>${this.monitor(g)}`).join(''));
  }

  private monitor(gp: Gamepad): string {
    const eixos = gp.axes
      .map((v, i) => `<div class="eixo"><span>${i}</span><div class="barra"><i style="left:${((v + 1) / 2) * 100}%"></i></div><span>${v.toFixed(2)}</span></div>`)
      .join('');
    const botoes = gp.buttons
      .map((b, i) => `<span class="bt ${b.pressed || b.value > 0.5 ? 'on' : ''}">${i}</span>`)
      .join('');
    return `<div class="monitor"><div class="eixos">${eixos}</div><div class="bts">${botoes}</div></div>`;
  }

  private ultimoHtml = '';
  private conteudo: HTMLElement | null = null;
  private monitorEl: HTMLElement | null = null;
  /** Parte estática (com botões) só é refeita quando muda; o monitor ao vivo é atualizado todo frame. */
  private render(html: string, monitor: string): void {
    if (!this.conteudo) {
      this.conteudo = document.createElement('div');
      this.monitorEl = document.createElement('div');
      this.el.append(this.conteudo, this.monitorEl);
    }
    if (html !== this.ultimoHtml) {
      this.ultimoHtml = html;
      this.conteudo.innerHTML = html;
      this.conteudo.querySelectorAll('button').forEach((b) => {
        b.onclick = () => this.clique(b.dataset.acao!, b.dataset.gp);
      });
    }
    this.monitorEl!.innerHTML = monitor;
  }

  private clique(acao: string, gpStr?: string): void {
    const gp = gpStr !== undefined ? this.gp(Number(gpStr)) : null;
    switch (acao) {
      case 'fechar':
        this.fechar();
        break;
      case 'calibrar':
        if (gp) this.iniciarAssistente(gp);
        break;
      case 'tipo':
        if (gp) {
          const p = this.entrada.perfil(gp);
          this.entrada.definirPerfil({ ...p, tipo: p.tipo === 'volante' ? 'controle' : 'volante' });
        }
        break;
      case 'padrao':
        if (gp) this.entrada.definirPerfil(perfilPadrao(gp));
        break;
      case 'pular': {
        const a = this.assistente;
        const g = a && this.gp(a.gpIndex);
        if (a && g) this.avancar(g);
        break;
      }
      case 'cancelar':
        this.assistente = null;
        break;
    }
    this.ultimoHtml = '';
  }
}
