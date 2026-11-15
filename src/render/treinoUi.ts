import * as THREE from 'three';
import { IdLicao, LICOES, Treino } from '../treino/treino';
import type { InfoPasso, Marcador } from '../treino/tipos';

/**
 * Tela do treino guiado: menu de lições + painel do passo atual (texto, dica,
 * medidor, pergunta, botões Continuar/Pular/Repetir/Sair). E `GuiasTreino`, que
 * desenha no chão as referências da lição (baliza etc.) — adicione `guias.grupo`
 * à cena e chame `guias.atualizar(treino, dt)` a cada quadro.
 */

const CSS = `
.tr-painel { position: absolute; left: 14px; bottom: 14px; z-index: 21; width: min(440px, calc(100vw - 28px));
  box-sizing: border-box; background: rgba(14, 17, 22, 0.9); border: 1px solid rgba(255,255,255,.12);
  border-radius: 14px; padding: 12px 14px 12px; color: #e9edf2;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.4);
  transition: opacity .25s, transform .25s; }
.tr-painel.oculto { opacity: 0; transform: translateY(12px); pointer-events: none; }
.tr-cab { display: flex; align-items: center; gap: 8px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #9aa5b1; }
.tr-cab b { color: #4aa8ff; font-weight: 700; }
.tr-cab span { margin-left: auto; }
.tr-trilha { display: flex; gap: 2px; margin: 6px 0 8px; }
.tr-trilha i { flex: 1; height: 3px; border-radius: 2px; background: #2a3340; }
.tr-trilha i.feito { background: #3ddc84; }
.tr-trilha i.atual { background: #4aa8ff; }
.tr-titulo { font-size: 17px; font-weight: 700; line-height: 1.25; margin-bottom: 4px; }
.tr-texto { font-size: 15px; line-height: 1.4; color: #d7dde4; }
.tr-dica { margin-top: 8px; font-size: 14px; line-height: 1.35; background: rgba(255, 176, 0, .12); border-left: 3px solid #ffb000;
  padding: 6px 9px; border-radius: 6px; color: #ffe2a3; }
.tr-dica::before { content: 'Dica: '; font-weight: 700; color: #ffb000; }
.tr-medidor { margin-top: 10px; }
.tr-medidor .rot { font-size: 12px; color: #9aa5b1; margin-bottom: 3px; display: flex; justify-content: space-between; }
.tr-barra { position: relative; height: 10px; border-radius: 5px; background: #222a35; overflow: hidden; }
.tr-barra .boa { position: absolute; top: 0; bottom: 0; background: rgba(61, 220, 132, .25); border-left: 1px solid #3ddc84aa; border-right: 1px solid #3ddc84aa; }
.tr-barra .val { position: absolute; left: 0; top: 0; bottom: 0; background: #4aa8ff; border-radius: 5px; transition: width .08s linear; }
.tr-barra .val.ok { background: #3ddc84; }
.tr-quiz { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.tr-quiz .perg { font-weight: 700; font-size: 15px; }
.tr-quiz button { text-align: left; display: flex; gap: 8px; align-items: baseline; }
.tr-quiz button kbd { font: 600 11px system-ui, sans-serif; color: #9aa5b1; background: #222a35; border-radius: 4px; padding: 1px 5px; white-space: nowrap; }
.tr-quiz button.certa { background: #1f5c3b; border-color: #3ddc84; }
.tr-quiz button.errada { background: #5c1f24; border-color: #ff5a5f; }
.tr-msg { margin-top: 8px; font-size: 14px; font-weight: 600; padding: 7px 10px; border-radius: 8px; }
.tr-msg.sucesso { background: rgba(61, 220, 132, .16); color: #8ff0b8; }
.tr-msg.erro { background: rgba(255, 90, 95, .16); color: #ffb0b3; }
.tr-msg.info { background: rgba(74, 168, 255, .14); color: #b5dcff; }
.tr-painel.festa .tr-titulo { animation: tr-festa .7s ease-out; color: #3ddc84; }
.tr-bts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.tr-painel button, .tr-menu button { font: 600 13px system-ui, sans-serif; color: #e9edf2; background: #222a35;
  border: 1px solid rgba(255,255,255,.14); border-radius: 8px; padding: 7px 11px; cursor: pointer; }
.tr-painel button:hover, .tr-menu button:hover { background: #2c3644; }
.tr-painel button.prim, .tr-menu button.prim { background: #1d5fa3; border-color: #4aa8ff; }
.tr-painel button.fraco { margin-left: auto; color: #9aa5b1; }
@keyframes tr-festa { 0% { transform: scale(1); } 35% { transform: scale(1.06); } 100% { transform: scale(1); } }

.tr-menu-fundo { position: absolute; inset: 0; z-index: 40; background: rgba(5, 8, 12, .62); display: flex; align-items: center; justify-content: center; }
.tr-menu-fundo.oculto { display: none; }
.tr-menu { width: min(720px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box;
  background: rgba(14, 17, 22, 0.97); border: 1px solid rgba(255,255,255,.12); border-radius: 16px; padding: 18px 18px 16px;
  color: #e9edf2; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; box-shadow: 0 12px 40px rgba(0,0,0,.5); }
.tr-menu h2 { margin: 0 0 4px; font-size: 22px; }
.tr-menu p.sub { margin: 0 0 14px; color: #9aa5b1; font-size: 14px; }
.tr-lista { display: grid; gap: 8px; }
.tr-licao { display: grid; grid-template-columns: 38px 1fr auto; gap: 12px; align-items: center; text-align: left; width: 100%;
  padding: 12px 14px !important; }
.tr-licao .num { width: 38px; height: 38px; border-radius: 50%; background: #1d5fa3; display: grid; place-items: center; font-size: 17px; font-weight: 800; }
.tr-licao .tit { font-size: 16px; font-weight: 700; }
.tr-licao .desc { font-size: 13px; font-weight: 400; color: #aab4bf; margin-top: 2px; line-height: 1.35; }
.tr-licao .pas { font-size: 12px; color: #9aa5b1; font-weight: 500; white-space: nowrap; }
.tr-menu .rodape { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 14px; color: #9aa5b1; font-size: 12px; }
@media (max-width: 520px) {
  .tr-titulo { font-size: 15px; } .tr-texto { font-size: 14px; }
  .tr-licao { grid-template-columns: 30px 1fr; } .tr-licao .pas { display: none; } .tr-licao .num { width: 30px; height: 30px; }
}
`;

let cssInjetado = false;
function injetarCss(): void {
  if (cssInjetado) return;
  cssInjetado = true;
  const s = document.createElement('style');
  s.dataset.modulo = 'treinoUi';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, txt?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
}

export class UiTreino {
  private readonly treino: Treino;
  private readonly aoEscolher: (id: IdLicao) => void;
  private readonly fundoMenu: HTMLDivElement;
  private readonly painel: HTMLDivElement;
  private readonly cabLicao: HTMLElement;
  private readonly cabPasso: HTMLSpanElement;
  private readonly trilha: HTMLDivElement;
  private readonly titulo: HTMLDivElement;
  private readonly texto: HTMLDivElement;
  private readonly dica: HTMLDivElement;
  private readonly medidor: HTMLDivElement;
  private readonly medRot: HTMLSpanElement;
  private readonly medVal: HTMLSpanElement;
  private readonly barraBoa: HTMLDivElement;
  private readonly barraVal: HTMLDivElement;
  private readonly quiz: HTMLDivElement;
  private readonly msg: HTMLDivElement;
  private readonly bts: HTMLDivElement;
  private chave = '';
  private chaveQuiz = '';
  private chaveBts = '';

  constructor(pai: HTMLElement, treino: Treino, aoEscolher: (id: IdLicao) => void) {
    injetarCss();
    this.treino = treino;
    this.aoEscolher = aoEscolher;

    // ---- menu
    this.fundoMenu = el('div', 'tr-menu-fundo oculto');
    const menu = el('div', 'tr-menu');
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Treino guiado');
    menu.append(el('h2', '', 'Treino guiado'), el('p', 'sub', 'Aulas curtas, passo a passo, com voz. Nunca dirigiu? Comece pela primeira.'));
    const lista = el('div', 'tr-lista');
    LICOES.forEach((l, i) => {
      const b = el('button', 'tr-licao');
      const num = el('span', 'num', String(i + 1));
      const meio = el('span');
      meio.append(el('div', 'tit', l.titulo), el('div', 'desc', l.descricao));
      b.append(num, meio, el('span', 'pas', `${l.passos} passos`));
      b.onclick = () => {
        this.fecharMenu();
        this.aoEscolher(l.id);
      };
      lista.appendChild(b);
    });
    const rodape = el('div', 'rodape');
    const fechar = el('button', '', 'Voltar');
    fechar.onclick = () => this.fecharMenu();
    rodape.append(el('span', '', 'Durante a lição: Pular, Repetir e Sair ficam no painel.'), fechar);
    menu.append(lista, rodape);
    this.fundoMenu.appendChild(menu);
    this.fundoMenu.addEventListener('click', (e) => {
      if (e.target === this.fundoMenu) this.fecharMenu();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.menuAberto) {
        e.preventDefault();
        this.fecharMenu();
      }
    });

    // ---- painel
    this.painel = el('div', 'tr-painel oculto');
    this.painel.setAttribute('role', 'status');
    this.painel.setAttribute('aria-live', 'polite');
    const cab = el('div', 'tr-cab');
    this.cabLicao = el('b');
    this.cabPasso = el('span');
    cab.append(el('span', '', 'Treino ·'), this.cabLicao, this.cabPasso);
    this.cabPasso.style.marginLeft = 'auto';
    this.trilha = el('div', 'tr-trilha');
    this.titulo = el('div', 'tr-titulo');
    this.texto = el('div', 'tr-texto');
    this.dica = el('div', 'tr-dica');
    this.medidor = el('div', 'tr-medidor');
    const rot = el('div', 'rot');
    this.medRot = el('span');
    this.medVal = el('span');
    rot.append(this.medRot, this.medVal);
    const barra = el('div', 'tr-barra');
    this.barraBoa = el('div', 'boa');
    this.barraVal = el('div', 'val');
    barra.append(this.barraBoa, this.barraVal);
    this.medidor.append(rot, barra);
    this.quiz = el('div', 'tr-quiz');
    this.msg = el('div', 'tr-msg');
    this.bts = el('div', 'tr-bts');
    this.painel.append(cab, this.trilha, this.titulo, this.texto, this.dica, this.medidor, this.quiz, this.msg, this.bts);

    pai.append(this.painel, this.fundoMenu);
  }

  abrirMenu(): void {
    this.fundoMenu.classList.remove('oculto');
    this.fundoMenu.querySelector<HTMLButtonElement>('.tr-licao')?.focus();
  }

  fecharMenu(): void {
    this.fundoMenu.classList.add('oculto');
  }

  get menuAberto(): boolean {
    return !this.fundoMenu.classList.contains('oculto');
  }

  atualizar(): void {
    const info = this.treino.passoAtual;
    const licao = this.treino.licao;
    this.painel.classList.toggle('oculto', !info);
    if (!info || !licao) {
      this.chave = '';
      return;
    }

    const chave = [licao.id, info.id, info.indice, info.total, info.titulo, info.texto, info.dica ?? '', info.mensagem?.texto ?? '', info.mensagem?.tipo ?? '', info.celebrando].join('|');
    if (chave !== this.chave) {
      const novoPasso = this.chave.split('|')[1] !== info.id;
      this.chave = chave;
      this.cabLicao.textContent = licao.titulo;
      this.cabPasso.textContent = info.tipo === 'fim' ? 'concluída' : `passo ${Math.min(info.indice + 1, info.total)} de ${info.total}`;
      if (this.trilha.childElementCount !== info.total) this.trilha.replaceChildren(...Array.from({ length: info.total }, () => el('i')));
      Array.from(this.trilha.children).forEach((c, i) => {
        c.className = info.tipo === 'fim' || i < info.indice ? 'feito' : i === info.indice ? 'atual' : '';
      });
      this.titulo.textContent = info.celebrando && info.mensagem?.tipo === 'sucesso' && info.tipo !== 'fim' ? info.mensagem.texto : info.titulo;
      this.texto.textContent = info.texto;
      this.dica.style.display = info.dica ? '' : 'none';
      this.dica.textContent = info.dica ?? '';
      const mostrarMsg = !!info.mensagem && !(info.celebrando && info.tipo !== 'fim');
      this.msg.style.display = mostrarMsg ? '' : 'none';
      this.msg.className = `tr-msg ${info.mensagem?.tipo ?? ''}`;
      this.msg.textContent = info.mensagem?.texto ?? '';
      if (info.celebrando && novoPasso === false) {
        this.painel.classList.remove('festa');
        void this.painel.offsetWidth;
        this.painel.classList.add('festa');
      } else if (!info.celebrando) this.painel.classList.remove('festa');
    }

    this.atualizarMedidor(info);
    this.atualizarQuiz(info);
    this.atualizarBotoes(info);
  }

  private atualizarMedidor(info: InfoPasso): void {
    const tem = info.progresso !== undefined && info.tipo !== 'fim' && info.tipo !== 'quiz';
    this.medidor.style.display = tem ? '' : 'none';
    if (!tem) return;
    const p = Math.max(0, Math.min(1, info.progresso!));
    this.medRot.textContent = info.rotuloProgresso ?? (info.tipo === 'leitura' ? 'Lendo…' : 'Progresso');
    this.medVal.textContent = info.faixaBoa ? (p >= info.faixaBoa[0] && p <= info.faixaBoa[1] ? 'no ponto!' : p > info.faixaBoa[1] ? 'passou' : '') : `${Math.round(p * 100)}%`;
    this.barraVal.style.width = `${(p * 100).toFixed(1)}%`;
    const ok = info.faixaBoa ? p >= info.faixaBoa[0] && p <= info.faixaBoa[1] : p >= 1;
    this.barraVal.classList.toggle('ok', ok);
    if (info.faixaBoa) {
      this.barraBoa.style.display = '';
      this.barraBoa.style.left = `${info.faixaBoa[0] * 100}%`;
      this.barraBoa.style.width = `${(info.faixaBoa[1] - info.faixaBoa[0]) * 100}%`;
    } else this.barraBoa.style.display = 'none';
  }

  private atualizarQuiz(info: InfoPasso): void {
    const q = info.quiz;
    const chave = q ? `${info.id}|${q.escolhida}|${q.teclas.join(',')}` : '';
    if (chave === this.chaveQuiz) return;
    this.chaveQuiz = chave;
    this.quiz.style.display = q ? '' : 'none';
    if (!q) {
      this.quiz.replaceChildren();
      return;
    }
    const perg = el('div', 'perg', q.pergunta);
    const bts = q.opcoes.map((op, i) => {
      const b = el('button');
      const tecla = q.teclas[i];
      if (tecla) b.append(el('kbd', '', tecla));
      b.append(el('span', '', op));
      if (q.escolhida !== null) {
        b.disabled = true;
        if (i === q.correta) b.classList.add('certa');
        else if (i === q.escolhida) b.classList.add('errada');
      }
      b.onclick = () => this.treino.responder(i);
      return b;
    });
    this.quiz.replaceChildren(perg, ...bts);
  }

  private atualizarBotoes(info: InfoPasso): void {
    const respondida = info.quiz?.escolhida !== null && info.quiz !== undefined;
    const continuar = info.tipo === 'leitura' || info.celebrando || respondida;
    const chave = `${info.tipo}|${continuar}|${info.celebrando}`;
    if (chave === this.chaveBts) return;
    this.chaveBts = chave;
    const b = (txt: string, cls: string, fn: () => void, titulo?: string) => {
      const x = el('button', cls, txt);
      x.onclick = fn;
      if (titulo) x.title = titulo;
      return x;
    };
    if (info.tipo === 'fim') {
      this.bts.replaceChildren(
        b('Repetir a lição', 'prim', () => this.treino.repetir()),
        b('Outras lições', '', () => this.abrirMenu()),
        b('Sair do treino', 'fraco', () => this.treino.sair()),
      );
      return;
    }
    const lista: HTMLButtonElement[] = [];
    if (continuar) lista.push(b('Continuar', 'prim', () => this.treino.continuar()));
    lista.push(
      b('Pular', '', () => this.treino.pular(), 'Pular este passo'),
      b('Repetir', '', () => this.treino.repetir(), 'Fazer este passo de novo'),
      b('Lições', '', () => this.abrirMenu()),
      b('Sair', 'fraco', () => this.treino.sair(), 'Sair do treino'),
    );
    this.bts.replaceChildren(...lista);
  }

  remover(): void {
    this.painel.remove();
    this.fundoMenu.remove();
  }
}

// ---------------------------------------------------------------- referências no chão (3D)

interface Visual {
  obj: THREE.Object3D;
  mats: THREE.MeshBasicMaterial[];
  tipo: Marcador['tipo'];
  dims: string;
}

/** Desenha os marcadores do treino (faixas, setas, vaga, hastes destacadas) no chão. */
export class GuiasTreino {
  readonly grupo = new THREE.Group();
  private readonly visuais = new Map<string, Visual>();
  private t = 0;

  constructor() {
    this.grupo.name = 'guias_treino';
    this.grupo.renderOrder = 5;
  }

  atualizar(marcadores: Marcador[], dt: number): void {
    this.t += dt;
    const vistos = new Set<string>();
    for (const m of marcadores) {
      vistos.add(m.id);
      const dims = `${m.tipo}|${m.largura}|${m.comprimento}`;
      let v = this.visuais.get(m.id);
      if (v && v.dims !== dims) {
        this.descartar(m.id);
        v = undefined;
      }
      if (!v) {
        v = this.criar(m, dims);
        this.visuais.set(m.id, v);
        this.grupo.add(v.obj);
      }
      v.obj.visible = true;
      v.obj.position.copy(m.posicao);
      v.obj.rotation.set(0, m.yaw, 0);
      const pulso = m.ativo ? 0.55 + 0.35 * Math.sin(this.t * 5) : 0.45;
      for (const mat of v.mats) {
        mat.color.setHex(m.cor);
        mat.opacity = (mat.userData.base as number) * pulso;
      }
      if (v.tipo === 'poste') v.obj.scale.setScalar(m.ativo ? 1 + 0.08 * Math.sin(this.t * 5) : 1);
    }
    for (const id of [...this.visuais.keys()]) if (!vistos.has(id)) this.descartar(id);
  }

  private material(base: number): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    m.userData.base = base;
    return m;
  }

  private criar(m: Marcador, dims: string): Visual {
    const g = new THREE.Group();
    const mats: THREE.MeshBasicMaterial[] = [];
    const chao = (geo: THREE.BufferGeometry, base: number, y = 0) => {
      const mat = this.material(base);
      mats.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = y;
      mesh.renderOrder = 5;
      g.add(mesh);
      return mesh;
    };
    if (m.tipo === 'linha') {
      // largura = transversal (X local), comprimento = ao longo (Z local)
      chao(new THREE.PlaneGeometry(m.largura, m.comprimento), 1.6);
    } else if (m.tipo === 'alvo') {
      chao(new THREE.PlaneGeometry(m.largura, m.comprimento), 0.35);
      const e = 0.09;
      const bordas: [number, number, number, number][] = [
        [0, m.comprimento / 2, m.largura, e], [0, -m.comprimento / 2, m.largura, e],
        [m.largura / 2, 0, e, m.comprimento], [-m.largura / 2, 0, e, m.comprimento],
      ];
      for (const [x, z, w, c] of bordas) {
        const b = chao(new THREE.PlaneGeometry(w, c), 1.8, 0.002);
        b.position.x = x;
        b.position.z = z;
      }
    } else if (m.tipo === 'poste') {
      chao(new THREE.RingGeometry(m.largura * 0.4, m.largura * 0.55, 28), 1.8);
      const mat = this.material(0.35);
      mats.push(mat);
      const halo = new THREE.Mesh(new THREE.CylinderGeometry(m.largura * 0.45, m.largura * 0.45, 1.6, 20, 1, true), mat);
      halo.position.y = 0.8;
      halo.renderOrder = 5;
      g.add(halo);
    } else {
      // seta apontando para +Z local
      const w = m.largura, c = m.comprimento;
      const s = new THREE.Shape();
      const haste = w * 0.32, ponta = c * 0.38;
      s.moveTo(-haste / 2, -c / 2);
      s.lineTo(haste / 2, -c / 2);
      s.lineTo(haste / 2, c / 2 - ponta);
      s.lineTo(w / 2, c / 2 - ponta);
      s.lineTo(0, c / 2);
      s.lineTo(-w / 2, c / 2 - ponta);
      s.lineTo(-haste / 2, c / 2 - ponta);
      s.closePath();
      const geo = new THREE.ShapeGeometry(s);
      // Shape em XY; deitado com rotation.x = −π/2, o +Y da forma vira −Z: espelha para apontar para +Z
      geo.scale(1, -1, 1);
      chao(geo, 1.6);
    }
    return { obj: g, mats, tipo: m.tipo, dims };
  }

  private descartar(id: string): void {
    const v = this.visuais.get(id);
    if (!v) return;
    this.grupo.remove(v.obj);
    v.obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    for (const m of v.mats) m.dispose();
    this.visuais.delete(id);
  }

  liberar(): void {
    for (const id of [...this.visuais.keys()]) this.descartar(id);
  }
}
