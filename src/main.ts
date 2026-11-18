import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import './style.css';
import { CarConfig, KWID, MOBI } from './sim/carConfig';
import { Comandos } from './sim/powertrain';
import { DT_FISICA, iniciarRapier, Simulacao } from './sim/simulation';
import { lerMapa, Mapa } from './world/parser';
import { criarMapaAutoescola } from './world/autoescola';
import { decorarAutoescola } from './world/autoescolaDecoracao';
import urlChao from './world/autoescola/chao.png?url';
import urlCampos from './world/autoescola/campos.png?url';
import { configurarCeu } from './world/ambiente';
import { atualizarIluminacaoPublica, criarIluminacaoPublica } from './world/iluminacao';
import { FAIXAS } from './world/vias';
import { carregarModelosCarros } from './world/modelosCarros';
import { AREAS_LIVRES_FERROVIA_PX } from './world/ferrovia';
import { alturaTerreno, METROS_POR_PX, px } from './world/autoescola';
import { Treino } from './treino/treino';
import type { AlvoCamera, Dispositivo } from './treino/tipos';
import { GuiasTreino, UiTreino } from './render/treinoUi';
import { Acao, ehVolante } from './input/input';
import { corSemaforo, CorSemaforo, Prova } from './exam/exam';
import { Entrada, EstadoEntrada } from './input/input';
import { Calibracao } from './input/calibration';
import { ControlesToque, temToque } from './input/toque';
import { Hud } from './render/hud';
import { VisualCarro } from './render/carVisual';
import { Retrovisores } from './render/mirrors';
import { SomCarro } from './audio/somCarro';
import { MovimentoCabeca } from './render/cabeca';
import { Opcoes, Config } from './render/opcoes';
import { Examinador } from './exam/examinador';
import { UiExaminador } from './render/examinadorUi';
import { mostrarRelatorio } from './render/relatorio';
import { Trafego } from './world/trafego';
import { Ferrovia } from './world/ferrovia';
import { SomFerrovia } from './audio/somFerrovia';
import { INFO_TRAFEGO_VAZIA, InfoTrafego } from './world/infoTrafego';

type ModoCamera = 'cockpit' | 'externa' | 'cima';
const MODOS: ModoCamera[] = ['cockpit', 'externa', 'cima'];
let CARRO: CarConfig = MOBI;

const app = document.getElementById('app')!;

// ---------- Renderização ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
app.appendChild(renderer.domElement);

const cena = new THREE.Scene();
const ceu = configurarCeu(cena, renderer);

const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.03, 800);
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ---------- Sistemas ----------
const entrada = new Entrada();
const toque = new ControlesToque(app);
entrada.toque = toque;
const hud = new Hud(app);
const calibracao = new Calibracao(entrada, app);
let som = new SomCarro({ rpmMarchaLenta: MOBI.motor.rpmMarchaLenta, rpmCorte: MOBI.motor.rpmCorte });
const opcoes = new Opcoes(app);
const uiExaminador = new UiExaminador(app);
const somFerrovia = new SomFerrovia();
CARRO = opcoes.valores.carro === 'kwid' ? KWID : MOBI;
ceu.definirHorario(opcoes.valores.horario, false);
som = new SomCarro({ rpmMarchaLenta: CARRO.motor.rpmMarchaLenta, rpmCorte: CARRO.motor.rpmCorte });
som.volume = opcoes.valores.volume;
const cabeca = new MovimentoCabeca();
cabeca.intensidade = opcoes.valores.movimentoCabeca;
let tempoSimCamera = 0;

function aplicarQualidade(c: Config): void {
  const dpr = window.devicePixelRatio || 1;
  renderer.setPixelRatio(c.qualidade === 'baixa' ? Math.min(dpr, 1) * 0.75 : c.qualidade === 'media' ? Math.min(dpr, 1.25) : Math.min(dpr, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  ceu.sol.castShadow = c.qualidade !== 'baixa';
  const tam = c.qualidade === 'alta' ? 2048 : 1024;
  if (ceu.sol.shadow.mapSize.x !== tam) {
    ceu.sol.shadow.mapSize.set(tam, tam);
    ceu.sol.shadow.map?.dispose();
    ceu.sol.shadow.map = null;
  }
  if (jogo) jogo.espelhos.intervaloLaterais = c.qualidade === 'alta' ? 2 : c.qualidade === 'media' ? 3 : 4;
  entrada.sensibilidade = c.sensibilidade;
  toque.definir(c.controlesToque === 'sim' || (c.controlesToque === 'auto' && temToque()), c.direcaoToque);
  som.volume = c.volume;
  somFerrovia.volume = c.volume;
  cabeca.intensidade = c.movimentoCabeca;
  if (ceu.horario !== c.horario) ceu.definirHorario(c.horario);
}
opcoes.aoMudar((c, antes) => {
  aplicarQualidade(c);
  if (jogo?.examinador) jogo.examinador.voz = c.vozExaminador;
  if (c.examinador !== antes.examinador && jogo) {
    jogo.examinador = c.examinador && jogo.mapa.raiz.name === 'autoescola'
      ? new Examinador(jogo.sim, jogo.prova, { voz: c.vozExaminador })
      : null;
  }
  if ((c.trafego !== antes.trafego || c.pedestres !== antes.pedestres) && jogo) {
    removerTrafego();
    jogo.trafego = criarTrafego(jogo.sim, jogo.mapa, c);
    const f = jogo.ferrovia;
    if (jogo.trafego && f) jogo.trafego.passagemBloqueada = () => f.estado !== 'livre';
  }
  if (c.carro !== antes.carro && jogo) {
    CARRO = c.carro === 'kwid' ? KWID : MOBI;
    carregarMapa(jogo.mapa.raiz);
    // motor diferente: refaz o som (precisa de um gesto do usuário, que é o clique no menu)
    som.volume = 0; // silencia o som do motor anterior
    som = new SomCarro({ rpmMarchaLenta: CARRO.motor.rpmMarchaLenta, rpmCorte: CARRO.motor.rpmCorte });
    som.volume = c.volume;
    som.iniciar();
  }
});

interface Jogo {
  mapa: Mapa;
  sim: Simulacao;
  prova: Prova;
  visual: VisualCarro;
  espelhos: Retrovisores;
  lampadas: { luzes: Record<CorSemaforo, THREE.MeshStandardMaterial>; sem: Mapa['semaforos'][number] }[];
  obstaculoMat: Map<object, THREE.MeshStandardMaterial[]>;
  examinador: Examinador | null;
  relatorioMostrado: boolean;
  trafego: Trafego | null;
  ferrovia: Ferrovia | null;
}

function criarTrafego(sim: Simulacao, mapa: Mapa, c: Config): Trafego | null {
  if (mapa.raiz.name !== 'autoescola' || (!c.trafego && !c.pedestres)) return null;
  const t = new Trafego(sim, { carros: c.trafego ? 6 : 0, pedestres: c.pedestres ? 6 : 0 });
  cena.add(t.grupo);
  return t;
}

function removerTrafego(): void {
  if (!jogo?.trafego) return;
  cena.remove(jogo.trafego.grupo);
  jogo.trafego.liberar();
  jogo.trafego = null;
}
let jogo: Jogo | null = null;

function montarSemaforos(mapa: Mapa): Jogo['lampadas'] {
  const out: Jogo['lampadas'] = [];
  const matCaixa = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.5 });
  for (const s of mapa.semaforos) {
    // Grupo focal (3 lâmpadas com pala) no topo do poste, virado para quem chega.
    const cabeca = new THREE.Group();
    cabeca.name = 'luzes_semaforo';
    cabeca.position.copy(s.topo).add(new THREE.Vector3(0, 0.55, 0));
    cabeca.rotation.y = s.yaw;
    const caixa = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.0, 0.24), matCaixa);
    caixa.castShadow = true;
    cabeca.add(caixa);
    const luzes = {} as Record<CorSemaforo, THREE.MeshStandardMaterial>;
    const cores: [CorSemaforo, number, number][] = [['vermelho', 0xff2a1a, 0.31], ['amarelo', 0xffb000, 0], ['verde', 0x18ff6a, -0.31]];
    for (const [nome, cor, y] of cores) {
      const m = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, emissive: cor, emissiveIntensity: 0 });
      const l = new THREE.Mesh(new THREE.CircleGeometry(0.11, 16), m);
      l.position.set(0, y, 0.121);
      const pala = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.12, 14, 1, true, -Math.PI / 2, Math.PI), matCaixa);
      pala.rotation.x = Math.PI / 2;
      pala.position.set(0, y + 0.02, 0.18);
      cabeca.add(l, pala);
      luzes[nome] = m;
    }
    mapa.raiz.add(cabeca);
    out.push({ luzes, sem: s });
  }
  return out;
}

function carregarMapa(raiz: THREE.Object3D): void {
  if (jogo) {
    removerTrafego();
    if (jogo.ferrovia) {
      cena.remove(jogo.ferrovia.grupo);
      jogo.ferrovia.liberar();
    }
    cena.remove(jogo.mapa.raiz, jogo.visual.grupo);
    jogo.sim.liberar();
  }
  raiz.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.receiveShadow = true;
  });
  // Remove luzes de semáforo de uma carga anterior do mesmo mapa (troca de carro).
  raiz.children.filter((c) => c.name === 'luzes_semaforo').forEach((c) => raiz.remove(c));
  const mapa = lerMapa(raiz);
  cena.add(raiz);
  const sim = new Simulacao(mapa, CARRO);
  const visual = new VisualCarro(sim.carro);
  cena.add(visual.grupo);

  // Material próprio por obstáculo (para pintar de vermelho quando tocado)
  const obstaculoMat = new Map<object, THREE.MeshStandardMaterial[]>();
  for (const o of mapa.obstaculos) {
    const mats: THREE.MeshStandardMaterial[] = [];
    o.objeto.traverse((x) => {
      const m = x as THREE.Mesh;
      if (m.isMesh && m.material) {
        m.material = (m.material as THREE.MeshStandardMaterial).clone();
        mats.push(m.material as THREE.MeshStandardMaterial);
      }
    });
    obstaculoMat.set(o, mats);
  }

  const prova = new Prova(sim);
  const ehAutoescola = raiz.name === 'autoescola';
  jogo = {
    mapa,
    sim,
    prova,
    examinador: ehAutoescola && opcoes.valores.examinador ? new Examinador(sim, prova, { voz: opcoes.valores.vozExaminador }) : null,
    relatorioMostrado: false,
    trafego: criarTrafego(sim, mapa, opcoes.valores),
    ferrovia: null,
    visual,
    espelhos: new Retrovisores(visual.retrovisores, visual.espelhos),
    lampadas: montarSemaforos(mapa),
    obstaculoMat,
  };
  entrada.reiniciarCabine();
  hud.reiniciar();
  camIniciada = false;
  if (raiz.name === 'autoescola') {
    const f = new Ferrovia(sim);
    cena.add(f.grupo);
    jogo.ferrovia = f;
    // carros do trânsito esperam no PARE dos trilhos enquanto a passagem não estiver livre
    if (jogo.trafego) jogo.trafego.passagemBloqueada = () => f.estado !== 'livre';
  }
  aplicarQualidade(opcoes.valores);
}

function reiniciarCarro(): void {
  if (!jogo) return;
  jogo.sim.reposicionar();
  jogo.sim.reporObstaculos();
  cabeca.reiniciar();
  jogo.trafego?.reiniciar();
  jogo.ferrovia?.reiniciar();
  jogo.prova = new Prova(jogo.sim);
  jogo.examinador?.reiniciar(jogo.prova);
  jogo.relatorioMostrado = false;
  for (const mats of jogo.obstaculoMat.values()) for (const m of mats) m.emissive?.setHex(0);
  entrada.reiniciarCabine();
  hud.reiniciar();
}

async function mapaAutoescola(): Promise<THREE.Object3D> {
  const campos = await new THREE.TextureLoader().loadAsync(urlCampos);
  campos.colorSpace = THREE.NoColorSpace; // coberturas, não cores
  campos.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const raiz = criarMapaAutoescola({ campos });
  decorarAutoescola(raiz);
  // Iluminação pública (antes de lerMapa: os postes viram sólidos). Fora do corredor do trem.
  const ilum = criarIluminacaoPublica(FAIXAS, {
    evitar: (x, z) => {
      const xp = x / METROS_POR_PX + 800, yp = z / METROS_POR_PX + 758;
      return AREAS_LIVRES_FERROVIA_PX.some((a) => xp > a.x0 - 30 && xp < a.x1 + 30 && yp > a.y0 - 30 && yp < a.y1 + 30);
    },
  });
  ilum.name = 'iluminacao_publica';
  raiz.add(ilum);
  return raiz;
}

async function carregarGLB(url: string): Promise<void> {
  const gltf = await new GLTFLoader().loadAsync(url);
  carregarMapa(gltf.scene);
}

// Arrastar um .glb exportado do Blender para a janela troca o mapa.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f || !/\.(glb|gltf)$/i.test(f.name)) return;
  const url = URL.createObjectURL(f);
  carregarGLB(url).catch((err) => alert(`Não consegui carregar o mapa: ${err}`)).finally(() => URL.revokeObjectURL(url));
});

// ---------- Câmera ----------
let modoCamera: ModoCamera = 'cockpit';
const olhar = { yaw: 0, pitch: 0, arrastando: false, yawSuave: 0, tras: 0 };
const ultimoPonteiro = { id: -1, x: 0, y: 0 };
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (olhar.arrastando) return; // um dedo só
  olhar.arrastando = true;
  Object.assign(ultimoPonteiro, { id: e.pointerId, x: e.clientX, y: e.clientY });
  renderer.domElement.setPointerCapture(e.pointerId);
});
const fimArrasto = (e: PointerEvent) => { if (e.pointerId === ultimoPonteiro.id) olhar.arrastando = false; };
renderer.domElement.addEventListener('pointerup', fimArrasto);
renderer.domElement.addEventListener('pointercancel', fimArrasto);
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!olhar.arrastando || e.pointerId !== ultimoPonteiro.id) return;
  const dx = e.clientX - ultimoPonteiro.x, dy = e.clientY - ultimoPonteiro.y;
  Object.assign(ultimoPonteiro, { x: e.clientX, y: e.clientY });
  olhar.yaw = Math.max(-2.4, Math.min(2.4, olhar.yaw - dx * 0.004));
  olhar.pitch = Math.max(-0.8, Math.min(0.6, olhar.pitch - dy * 0.004));
});
const camPos = new THREE.Vector3();
const camAlvo = new THREE.Vector3();
let camIniciada = false;

// ---------- Treino guiado ----------
let focoCamera: AlvoCamera = null;
let focoPeso = 0;
/** Pontos das peças do carro no referencial do carro (aprox. do modelo do Mobi). */
function pontoDoCarro(a: Exclude<AlvoCamera, null>): THREE.Vector3 {
  const Y = (h: number) => h - CARRO.alturaCG;
  switch (a) {
    case 'volante': return new THREE.Vector3(0.36, Y(0.9), -0.05);
    case 'pedais': return new THREE.Vector3(0.34, Y(0.32), 0.38);
    case 'cambio': return new THREE.Vector3(0.02, Y(0.62), 0.05);
    case 'freioDeMao': return new THREE.Vector3(0, Y(0.47), -0.5);
    case 'espelhoCentro': return new THREE.Vector3(0, Y(1.31), -0.01);
    case 'espelhoEsq': return new THREE.Vector3(0.96, Y(1.04), 0.44);
    case 'espelhoDir': return new THREE.Vector3(-0.96, Y(1.04), 0.44);
    case 'painel': return new THREE.Vector3(0.36, Y(0.98), 0.18);
    case 'frente': return new THREE.Vector3(0.36, Y(1.1), 12);
  }
}

const NOMES_G29 = ['X', '□', '○', '△', 'borboleta direita', 'borboleta esquerda', 'R2', 'L2', 'Share', 'Options', 'R3', 'L3',
  'câmbio na 1ª', 'câmbio na 2ª', 'câmbio na 3ª', 'câmbio na 4ª', 'câmbio na 5ª', 'câmbio na 6ª', 'câmbio na ré', '+', '−'];
const NOMES_CONTROLE = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Select/Share', 'Start/Options', 'L3', 'R3', 'direcional ↑', 'direcional ↓', 'direcional ←', 'direcional →'];
const NOMES_TECLADO: Partial<Record<Acao, string>> = {
  volante: 'A/D (ou ←/→)', acelerador: 'W (ou ↑)', freio: 'S (ou ↓)', embreagem: 'Shift',
  marcha1: 'tecla 1', marcha2: 'tecla 2', marcha3: 'tecla 3', marcha4: 'tecla 4', marcha5: 'tecla 5', marchaR: 'tecla R',
  freioDeMao: 'Espaço', partida: 'tecla I', setaEsq: 'tecla Q', setaDir: 'tecla E', farol: 'tecla L', alerta: 'tecla K',
  cinto: 'tecla C', olharEsq: 'tecla Z', olharDir: 'tecla X', olharTras: 'tecla B', camera: 'tecla V', encerrar: 'Enter', reiniciar: 'Backspace',
};

const NOMES_TOQUE: Partial<Record<Acao, string>> = {
  embreagem: 'o pedal Embreagem da tela, à esquerda (dedo mais alto = mais fundo)',
  freio: 'o pedal Freio da tela', acelerador: 'o pedal Acelerador da tela, à direita',
  marcha1: 'o 1 do câmbio da tela', marcha2: 'o 2 do câmbio da tela', marcha3: 'o 3 do câmbio da tela',
  marcha4: 'o 4 do câmbio da tela', marcha5: 'o 5 do câmbio da tela', marchaR: 'o R do câmbio da tela',
  freioDeMao: 'o botão Freio de mão', partida: 'o botão Partida (segure)', setaEsq: 'o botão ◀ Seta', setaDir: 'o botão Seta ▶',
  farol: 'o botão Farol', alerta: 'o botão Alerta', cinto: 'o botão Cinto', olharEsq: 'o botão 👀◀', olharDir: 'o botão ▶👀',
  olharTras: 'o botão Trás', camera: 'o botão 🎥',
};
function nomeToque(a: Acao): string {
  if (a === 'volante') return opcoes.valores.direcaoToque === 'inclinar' ? 'inclinando o aparelho, como um volante' : 'o volante da tela, à esquerda';
  return NOMES_TOQUE[a] ?? a;
}

function perfilControles(): { dispositivo: Dispositivo; nomeDe: (acao: Acao) => string } {
  const gps = entrada.gamepads();
  const gp = gps.find((g) => ehVolante(g)) ?? gps[0];
  if (!gp && toque.estaAtivo) return { dispositivo: 'toque', nomeDe: nomeToque };
  if (!gp) return { dispositivo: 'teclado', nomeDe: (a) => NOMES_TECLADO[a] ?? a };
  const perfil = entrada.perfil(gp);
  const volante = perfil.tipo === 'volante';
  return {
    dispositivo: volante ? 'volante' : 'controle',
    nomeDe: (a) => {
      const v = perfil.vinculos[a];
      if (!v) return `${NOMES_TECLADO[a] ?? a} (teclado)`;
      if (v.tipo === 'botao') return `botão ${(volante ? NOMES_G29 : NOMES_CONTROLE)[v.indice] ?? v.indice}`;
      if (v.tipo === 'eixoBotao') return volante ? (v.alvo < 0 || v.alvo > 0.5 ? 'direcional ←' : 'direcional →') : `eixo ${v.indice}`;
      if (volante) {
        if (a === 'volante') return 'o volante';
        if (a === 'embreagem') return 'o pedal da esquerda (embreagem)';
        if (a === 'freio') return 'o pedal do meio (freio)';
        if (a === 'acelerador') return 'o pedal da direita (acelerador)';
      } else {
        if (a === 'volante') return 'o analógico esquerdo';
        if (a === 'embreagem') return 'o analógico direito para baixo';
        if (a === 'olhar') return 'o analógico direito para os lados';
      }
      return `eixo ${v.indice}`;
    },
  };
}

/**
 * Voz do treino em português, em fila própria. Cada frase lembra de qual cartão
 * do treino ela é (`treino.geracao`): quando o cartão muda, as frases antigas
 * que ainda estão na fila são descartadas, e um texto de cartão antigo que
 * esteja tocando é cortado. Assim a voz sempre fala do cartão que está na tela.
 */
interface Fala { texto: string; tipo: 'cartao' | 'aviso'; ger: number }
const filaFala: Fala[] = [];
let falando: { fala: Fala; u: SpeechSynthesisUtterance } | null = null;
let geracaoFalada = 0;

function proximaFala(): void {
  if (typeof speechSynthesis === 'undefined') return;
  const ger = treino.geracao;
  if (falando && falando.fala.ger !== ger && falando.fala.tipo === 'cartao') {
    const u = falando.u;
    falando = null;
    u.onend = u.onerror = null;
    speechSynthesis.cancel();
  }
  while (filaFala.length && filaFala[0].ger !== ger) filaFala.shift();
  if (falando || !filaFala.length) return;
  const fala = filaFala.shift()!;
  const u = new SpeechSynthesisUtterance(fala.texto);
  u.lang = 'pt-BR';
  const voz = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('pt'));
  if (voz) u.voice = voz;
  u.volume = Math.min(1, opcoes.valores.volume + 0.2);
  u.onend = u.onerror = () => {
    if (falando?.u === u) falando = null;
    proximaFala();
  };
  falando = { fala, u };
  speechSynthesis.speak(u);
}

function falar(texto: string, tipo: 'cartao' | 'aviso' = 'aviso'): void {
  if (!opcoes.valores.vozExaminador || typeof speechSynthesis === 'undefined') return;
  filaFala.push({ texto, tipo, ger: treino.geracao });
  proximaFala();
}

let entAtual: EstadoEntrada | null = null;
const treino = new Treino({
  get sim() { return jogo!.sim; },
  entrada: () => entAtual!,
  perfilControles,
  focarCamera: (a) => {
    focoCamera = a;
    if (a) modoCamera = 'cockpit';
  },
  teleportar: (x, y, yaw) => {
    if (!jogo) return;
    const p = px(x, y);
    p.y = alturaTerreno(p.x, p.z);
    jogo.sim.carro.posicionar(p, yaw);
    jogo.sim.reporObstaculos();
    jogo.ferrovia?.reiniciar();
    entrada.reiniciarCabine();
    camIniciada = false;
  },
  falar,
});
const guias = new GuiasTreino();
cena.add(guias.grupo);
let treinoAnterior: string | null = null;
const uiTreino = new UiTreino(app, treino, (id) => {
  if (!jogo) return;
  // Sem trânsito durante o treino (a lição usa as faixas livres); sem prova.
  removerTrafego();
  treino.iniciar(id);
});

/** Liga/desliga o modo treino (esconde a prova e o examinador). */
function aplicarModoTreino(): void {
  const ativo = treino.ativa !== null;
  document.querySelector('.hud .prova')?.classList.toggle('oculto', ativo);
  if (!ativo && treinoAnterior !== null && jogo) {
    // saiu do treino: volta para a prova do início, com o trânsito
    jogo.trafego = criarTrafego(jogo.sim, jogo.mapa, opcoes.valores);
    const f = jogo.ferrovia;
    if (jogo.trafego && f) jogo.trafego.passagemBloqueada = () => f.estado !== 'livre';
    focoCamera = null;
    reiniciarCarro();
  }
  treinoAnterior = treino.ativa;
}

function atualizarCamera(dt: number, olharEntrada: number, olharTras: boolean): void {
  if (!jogo) return;
  const g = jogo.visual.grupo;
  if (!olhar.arrastando) {
    olhar.yaw *= Math.exp(-dt * 2.5);
    olhar.pitch *= Math.exp(-dt * 2.5);
  }
  // Direcional/analógico: olhar para os lados (virar a cabeça para os retrovisores/ponto cego).
  // Olhar para trás: vira a cabeça por cima do ombro direito (como para dar ré).
  const alvoYaw = olharTras ? -2.75 : olhar.yaw - olharEntrada * 1.25;
  olhar.yawSuave += (alvoYaw - olhar.yawSuave) * Math.min(1, dt * 7);
  olhar.tras += ((olharTras ? 1 : 0) - olhar.tras) * Math.min(1, dt * 7);
  // Cabeça do motorista: força G, vibração do motor e da rua
  {
    const c = jogo.sim.carro;
    const lv = c.corpo.linvel();
    const rq = c.corpo.rotation();
    const tSim = jogo.sim.tempo;
    cabeca.atualizar(dt, {
      vel: new THREE.Vector3(lv.x, lv.y, lv.z),
      rot: new THREE.Quaternion(rq.x, rq.y, rq.z, rq.w),
      dtSim: Math.max(0, tSim - tempoSimCamera),
      rpm: c.trem.rpm,
      rpmLenta: c.cfg.motor.rpmMarchaLenta,
      ligado: c.trem.ligado,
      cilindros: c.cfg.motor.cilindros,
      carga: c.trem.carga,
    });
    tempoSimCamera = tSim;
  }
  if (modoCamera === 'cockpit') {
    jogo.visual.olho.getWorldPosition(camera.position);
    g.getWorldQuaternion(camera.quaternion);
    camera.position.add(cabeca.desloc.clone().applyQuaternion(camera.quaternion));
    // Ao virar para trás, o tronco gira e a cabeça vai para o centro do carro.
    camera.position.add(new THREE.Vector3(-0.2, 0.07, -0.08).multiplyScalar(olhar.tras).applyQuaternion(camera.quaternion));
    camera.rotateY(Math.PI + olhar.yawSuave); // câmera olha para −Z; carro aponta +Z
    camera.rotateX(-0.06 + olhar.pitch + cabeca.giro.x);
    camera.rotateZ(cabeca.giro.z);
    // Treino: aponta a câmera para uma peça do carro (o olhar do jogador tem prioridade)
    const livre = Math.abs(olharEntrada) < 0.05 && !olharTras && !olhar.arrastando;
    focoPeso += ((focoCamera && livre ? 1 : 0) - focoPeso) * Math.min(1, dt * 4);
    if (focoCamera && focoPeso > 0.001) {
      const alvo = pontoDoCarro(focoCamera).applyMatrix4(g.matrixWorld);
      const q0 = camera.quaternion.clone();
      camera.lookAt(alvo);
      camera.quaternion.copy(q0.slerp(camera.quaternion, focoPeso));
    }
    camera.fov = opcoes.valores.fov;
  } else {
    const frente = new THREE.Vector3(0, 0, 1).applyQuaternion(g.quaternion);
    frente.y = 0;
    frente.normalize();
    const alvoPos =
      modoCamera === 'externa'
        ? g.position.clone().addScaledVector(frente.applyAxisAngle(new THREE.Vector3(0, 1, 0), olhar.yawSuave), -6.5).add(new THREE.Vector3(0, 2.3, 0))
        : g.position.clone().add(new THREE.Vector3(0, 24, 0)).addScaledVector(frente, -0.01);
    const a = camIniciada ? 1 - Math.exp(-dt * 6) : 1;
    camPos.lerp(alvoPos, a);
    camAlvo.lerp(g.position.clone().add(new THREE.Vector3(0, 0.6, 0)), camIniciada ? 1 - Math.exp(-dt * 12) : 1);
    camIniciada = true;
    camera.position.copy(camPos);
    camera.lookAt(camAlvo);
    camera.fov = modoCamera === 'cima' ? 45 : 60;
  }
  camera.updateProjectionMatrix();
}

// ---------- Teclas fora do jogo ----------
let ajudaAberta = false;
const ajuda = document.getElementById('ajuda')!;
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyO' && !calibracao.estaAberta) {
    e.preventDefault();
    if (opcoes.estaAberta) opcoes.fechar();
    else opcoes.abrir();
  } else if (e.code === 'KeyT' && !calibracao.estaAberta && !opcoes.estaAberta) {
    e.preventDefault();
    if (uiTreino.menuAberto) uiTreino.fecharMenu();
    else uiTreino.abrirMenu();
  } else if (e.code === 'F2') {
    e.preventDefault();
    if (calibracao.estaAberta) calibracao.fechar();
    else calibracao.abrir();
  } else if (e.code === 'KeyH' || e.code === 'F1') {
    e.preventDefault();
    ajudaAberta = !ajudaAberta;
    ajuda.classList.toggle('oculto', !ajudaAberta);
  }
});

// ---------- Loop ----------
let acumulador = 0;
let ultimo = performance.now();
let bloqueiaPartida = false;
let piscandoAnterior = false;
// Estado anterior para disparar os sons de eventos (bordas)
const anterior = { marcha: 0, freioDeMao: true, cinto: false, naCalcada: false, vel: new THREE.Vector3() };

/** Volante físico → volante do carro: 1:1 em graus, ou o curso todo até o batente. */
function volanteDoCarro(ent: EstadoEntrada): number {
  const c = opcoes.valores;
  if (!ent.temVolante || !c.volante1para1) return ent.volante;
  const batenteCarro = CARRO.direcao.voltasBatenteABatente * 360;
  return Math.max(-1, Math.min(1, (ent.volante * c.rotacaoVolante) / batenteCarro));
}

function comandosDe(ent: EstadoEntrada, desligar: boolean): Comandos {
  return {
    volante: volanteDoCarro(ent),
    acelerador: ent.acelerador,
    freio: ent.freio,
    embreagem: ent.embreagem,
    freioDeMao: ent.freioDeMao,
    marcha: ent.marcha,
    partida: ent.partida && !bloqueiaPartida,
    desligar,
  };
}

function quadro(agora: number): void {
  requestAnimationFrame(quadro);
  const dt = Math.min(0.1, (agora - ultimo) / 1000);
  ultimo = agora;
  if (!jogo) return;

  entrada.pausado = calibracao.estaAberta || opcoes.estaAberta || uiTreino.menuAberto;
  const ent = entrada.ler(dt);
  entAtual = ent;
  const emTreino = treino.ativa !== null;
  const trem = jogo.sim.carro.trem;

  // Partida: apertar com o motor ligado desliga; segurar com ele desligado dá partida.
  let desligar = false;
  if (ent.partidaBorda && trem.ligado) {
    desligar = true;
    bloqueiaPartida = true;
  }
  if (!ent.partida) bloqueiaPartida = false;

  if (ent.bordas.has('camera')) modoCamera = MODOS[(MODOS.indexOf(modoCamera) + 1) % MODOS.length];
  if (ent.bordas.has('reiniciar')) {
    if (emTreino) treino.repetir();
    else reiniciarCarro();
  }
  if (ent.bordas.has('encerrar') && !emTreino) jogo.prova.encerrar();

  const cabine = { seta: ent.seta, cinto: ent.cinto, farol: ent.farol, alerta: ent.alerta };
  if (!calibracao.estaAberta && !opcoes.estaAberta && !uiTreino.menuAberto) {
    acumulador += dt;
    let primeiro = true;
    while (acumulador >= DT_FISICA) {
      const cmd = comandosDe(ent, desligar && primeiro);
      primeiro = false;
      jogo.trafego?.passo(DT_FISICA);
      jogo.ferrovia?.passo(DT_FISICA);
      jogo.sim.passo(cmd);
      const eventos = trem.eventos.splice(0);
      for (const ev of eventos) {
        som.evento(ev);
        if (ev === 'pegou') cabeca.tranco(0.005, 0.6, 6);
        else if (ev === 'apagou') cabeca.tranco(0.012, 0.7, 4.5, 0.8);
      }
      const info: InfoTrafego | undefined = jogo.trafego?.info() ?? (jogo.ferrovia ? { ...INFO_TRAFEGO_VAZIA, eventos: [] } : undefined);
      if (info && jogo.ferrovia) {
        info.passagemFechada = jogo.ferrovia.estado !== 'livre';
        // bater no trem conta como colisão (interrompe a prova)
        for (const _ of jogo.ferrovia.eventos()) info.eventos.push('colisao_carro');
      }
      if (info?.eventos.includes('colisao_carro')) {
        som.evento('batida', 0.8);
        cabeca.tranco(0.02, 0.5, 8);
      }
      if (!emTreino) jogo.prova.atualizar(DT_FISICA, cmd, cabine, eventos, info);
      acumulador -= DT_FISICA;
    }
  }

  const t = jogo.sim.tempo;
  const piscando = Math.floor(t * 2.7) % 2 === 0;
  if ((ent.seta || ent.alerta) && piscando !== piscandoAnterior) som.evento('seta');
  piscandoAnterior = piscando;

  // Visual
  const kmh = Math.abs(jogo.sim.carro.velocidadeLongitudinal() * 3.6);
  jogo.visual.atualizar(jogo.sim.carro, {
    freando: ent.freio > 0.05,
    re: trem.marchaEngatada === -1,
    farol: ent.farol,
    alerta: ent.alerta,
    seta: ent.seta,
    piscando,
    cockpit: modoCamera === 'cockpit',
    semMaoDireita: (focoCamera === 'cambio' || focoCamera === 'freioDeMao') && focoPeso > 0.3,
    acelerador: ent.acelerador,
    freio: ent.freio,
    embreagem: ent.embreagem,
    marcha: trem.marchaEngatada,
    freioDeMao: ent.freioDeMao,
    rpm: Math.max(0, trem.rpm),
    velocidadeKmh: kmh,
    ignicao: trem.ignicao || trem.ligado,
    motorLigado: trem.ligado,
    cinto: ent.cinto,
  });
  for (const l of jogo.lampadas) {
    const cor = corSemaforo(l.sem, t);
    for (const k of Object.keys(l.luzes) as CorSemaforo[]) l.luzes[k].emissiveIntensity = k === cor ? 2.5 : 0.05;
  }
  for (const o of jogo.prova.obstaculosTocados) for (const m of jogo.obstaculoMat.get(o) ?? []) m.emissive?.setHex(0x880000);

  jogo.trafego?.atualizarVisual(dt);
  const ilum = jogo.mapa.raiz.getObjectByName('iluminacao_publica');
  if (ilum) atualizarIluminacaoPublica(ilum as THREE.Group, jogo.visual.grupo.position, dt);
  if (jogo.ferrovia) {
    jogo.ferrovia.atualizarVisual(dt);
    const pc = jogo.visual.grupo.position;
    const et = jogo.ferrovia.estadoTrem();
    const zTrem = Math.max(Math.min(pc.z, et.zTras), et.zFrente);
    somFerrovia.atualizar(
      jogo.ferrovia.sinoTocando,
      jogo.ferrovia.buzinaTocando,
      pc.distanceTo(jogo.ferrovia.cruzamento.centro),
      Math.hypot(pc.x - et.x, pc.z - zTrem),
    );
  }
  ceu.atualizarSombra(jogo.visual.grupo.position);
  atualizarCamera(dt, ent.olhar, ent.olharTras);
  // Som
  {
    const carro = jogo.sim.carro;
    if (trem.marchaEngatada !== anterior.marcha && trem.marchaEngatada !== 0) som.evento('marcha');
    anterior.marcha = trem.marchaEngatada;
    if (ent.freioDeMao !== anterior.freioDeMao) som.evento('freioDeMao');
    anterior.freioDeMao = ent.freioDeMao;
    if (ent.cinto !== anterior.cinto) som.evento('cinto');
    anterior.cinto = ent.cinto;
    let esc = 0;
    let aderencia = 0;
    let naCalcada = false;
    carro.rodas.forEach((r, i) => {
      if (!r.noChao) return;
      esc = Math.max(esc, Math.hypot(trem.omegaRoda[i] * CARRO.roda.raio - r.vx, r.vy));
      aderencia = Math.max(aderencia, r.uso);
      if (r.colisorChao !== null && jogo!.sim.tipoColisor.get(r.colisorChao) === 'calcada') naCalcada = true;
    });
    const lv = carro.corpo.linvel();
    const v = new THREE.Vector3(lv.x, lv.y, lv.z);
    if (naCalcada && !anterior.naCalcada) {
      som.evento('meioFio', Math.min(1, v.length() / 6));
      cabeca.tranco(0.008 * Math.min(1, v.length() / 6), 0.3, 11);
    }
    anterior.naCalcada = naCalcada;
    // Batida: mudança brusca de velocidade (bem acima do que os freios conseguem)
    const dv = v.distanceTo(anterior.vel);
    if (dt > 0 && dv / dt > 25 && dv > 0.8) {
      som.evento('batida', Math.min(1, dv / 6));
      cabeca.tranco(0.025 * Math.min(1, dv / 6), 0.5, 8);
    }
    anterior.vel.copy(v);
    som.atualizar(dt, {
      rpm: trem.rpm,
      carga: trem.aceleradorEfetivo,
      ligado: trem.ligado,
      partida: ent.partida && !bloqueiaPartida && !trem.ligado,
      ignicao: trem.ignicao || trem.ligado,
      velocidade: v.length(),
      escorregamento: esc,
      aderencia,
      freio: ent.freio,
      embreagem: ent.embreagem,
      marcha: trem.marchaEngatada,
      cockpit: modoCamera === 'cockpit',
    });
  }

  hud.atualizar(jogo.sim.carro, ent, jogo.prova, t, piscando, modoCamera, dt);
  toque.atualizarUi({ marcha: ent.marcha, freioDeMao: ent.freioDeMao, cinto: ent.cinto, farol: ent.farol, alerta: ent.alerta, seta: ent.seta, motorLigado: trem.ligado, velocidade: Math.abs(jogo.sim.carro.velocidadeLongitudinal()) }, ent.volante);
  // Treino guiado
  if (emTreino) treino.atualizar(dt);
  if (treino.geracao !== geracaoFalada) {
    // cartão mudou (ou saiu do treino): descarta/corta falas do cartão anterior
    geracaoFalada = treino.geracao;
    proximaFala();
  }
  uiTreino.atualizar();
  // marcas no chão: as da lição no treino; na prova, as da etapa do examinador (ex.: onde parar no meio-fio)
  guias.atualizar(emTreino ? treino.marcadores : jogo.examinador?.marcadores ?? [], dt);
  aplicarModoTreino();
  if (jogo.examinador && !emTreino) {
    jogo.examinador.atualizar(dt);
    uiExaminador.atualizar(jogo.examinador);
  } else {
    uiExaminador.ocultar();
  }
  // Fim da prova → relatório
  if (!emTreino && jogo.prova.encerrada && !jogo.relatorioMostrado) {
    jogo.relatorioMostrado = true;
    mostrarRelatorio(app, jogo.prova, {
      urlMapa: urlChao,
      onNovaProva: () => reiniciarCarro(),
      onFechar: () => {},
    });
  }
  const faltando = entrada.semCalibracao();
  hud.avisoCalibracao(faltando.length ? `“${faltando[0].id.slice(0, 40)}” não tem mapeamento conhecido — configure em F2` : null);

  if (modoCamera === 'cockpit') jogo.espelhos.render(renderer, cena);
  renderer.render(cena, camera);
}

// ---------- Toque: menus e tela cheia ----------
async function telaCheiaPaisagem(): Promise<void> {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
  } catch { /* navegador sem suporte (iPhone): segue sem tela cheia */ }
}
toque.aoAcao = (a) => {
  if (a === 'treino') { if (uiTreino.menuAberto) uiTreino.fecharMenu(); else uiTreino.abrirMenu(); }
  else if (a === 'opcoes') { if (opcoes.estaAberta) opcoes.fechar(); else opcoes.abrir(); }
  else if (a === 'telaCheia') {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else telaCheiaPaisagem();
  } else if (a === 'zerarInclinacao') toque.zerarInclinacao();
};

// ---------- Início ----------
async function iniciar(): Promise<void> {
  await Promise.all([iniciarRapier(), carregarModelosCarros().catch((e) => console.warn('carros do trânsito: usando os simples', e))]);
  const params = new URLSearchParams(location.search);
  const glb = params.get('mapa');
  try {
    if (glb) await carregarGLB(glb);
    else carregarMapa(await mapaAutoescola());
  } catch (err) {
    console.error(err);
    app.textContent = `Erro ao carregar o mapa: ${err}`;
    return;
  }
  requestAnimationFrame(quadro);

  const inicio = document.getElementById('inicio')!;
  const fecharInicio = () => {
    if (toque.estaAtivo) {
      telaCheiaPaisagem();
      toque.pedirSensor().then(() => setTimeout(() => toque.zerarInclinacao(), 400));
    }
    som.iniciar();
    somFerrovia.iniciar();
    inicio.classList.add('oculto');
  };
  inicio.querySelector<HTMLButtonElement>('[data-acao="jogar"]')!.onclick = fecharInicio;
  if (params.get('inicio') === '0') inicio.classList.add('oculto');
  const cam = params.get('camera') as ModoCamera | null;
  if (cam && MODOS.includes(cam)) modoCamera = cam;
  inicio.querySelector<HTMLButtonElement>('[data-acao="calibrar"]')!.onclick = () => {
    fecharInicio();
    calibracao.abrir();
  };
  inicio.querySelector<HTMLButtonElement>('[data-acao="opcoes"]')!.onclick = () => opcoes.abrir();
  inicio.querySelector<HTMLButtonElement>('[data-acao="treino"]')!.onclick = () => {
    fecharInicio();
    uiTreino.abrirMenu();
  };

}

iniciar().catch((e) => {
  console.error(e);
  app.textContent = `Erro ao iniciar: ${e}`;
});
