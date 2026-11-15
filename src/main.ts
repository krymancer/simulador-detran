import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import './style.css';
import { MOBI } from './sim/carConfig';
import { Comandos } from './sim/powertrain';
import { DT_FISICA, iniciarRapier, Simulacao } from './sim/simulation';
import { lerMapa, Mapa } from './world/parser';
import { criarMapaTeste } from './world/testMap';
import { criarMapaAutoescola } from './world/autoescola';
import { decorarAutoescola } from './world/autoescolaDecoracao';
import urlChao from './world/autoescola/chao.png?url';
import { configurarCeu } from './world/ambiente';
import { corSemaforo, CorSemaforo, Prova } from './exam/exam';
import { Entrada, EstadoEntrada } from './input/input';
import { Calibracao } from './input/calibration';
import { Hud } from './render/hud';
import { VisualCarro } from './render/carVisual';
import { Retrovisores } from './render/mirrors';
import { SomMotor } from './audio/engineSound';

type ModoCamera = 'cockpit' | 'externa' | 'cima';
const MODOS: ModoCamera[] = ['cockpit', 'externa', 'cima'];
const CARRO = MOBI;

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
const hud = new Hud(app);
const calibracao = new Calibracao(entrada, app);
const som = new SomMotor();

interface Jogo {
  mapa: Mapa;
  sim: Simulacao;
  prova: Prova;
  visual: VisualCarro;
  espelhos: Retrovisores;
  lampadas: { luzes: Record<CorSemaforo, THREE.MeshStandardMaterial>; sem: Mapa['semaforos'][number] }[];
  obstaculoMat: Map<object, THREE.MeshStandardMaterial[]>;
}
let jogo: Jogo | null = null;

function montarSemaforos(mapa: Mapa): Jogo['lampadas'] {
  const out: Jogo['lampadas'] = [];
  for (const s of mapa.semaforos) {
    const caixa = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.95, 0.3), new THREE.MeshStandardMaterial({ color: 0x1a1a1a }));
    caixa.position.copy(s.topo).add(new THREE.Vector3(0, 0.45, 0));
    const luzes = {} as Record<CorSemaforo, THREE.MeshStandardMaterial>;
    const cores: [CorSemaforo, number, number][] = [['vermelho', 0xff2020, 0.28], ['amarelo', 0xffb000, 0], ['verde', 0x20ff50, -0.28]];
    for (const [nome, cor, y] of cores) {
      const m = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: cor, emissiveIntensity: 0 });
      for (const lado of [1, -1]) {
        const l = new THREE.Mesh(new THREE.CircleGeometry(0.1, 12), m);
        l.position.set(lado * 0.181, y, 0);
        l.rotation.y = (lado * Math.PI) / 2;
        caixa.add(l);
      }
      luzes[nome] = m;
    }
    mapa.raiz.add(caixa);
    out.push({ luzes, sem: s });
  }
  return out;
}

function carregarMapa(raiz: THREE.Object3D): void {
  if (jogo) {
    cena.remove(jogo.mapa.raiz, jogo.visual.grupo);
    jogo.sim.liberar();
  }
  raiz.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.receiveShadow = true;
  });
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

  jogo = {
    mapa,
    sim,
    prova: new Prova(sim),
    visual,
    espelhos: new Retrovisores(visual.retrovisores, visual.espelhos),
    lampadas: montarSemaforos(mapa),
    obstaculoMat,
  };
  entrada.reiniciarCabine();
  hud.reiniciar();
  camIniciada = false;
}

function reiniciarCarro(): void {
  if (!jogo) return;
  jogo.sim.reposicionar();
  jogo.sim.reporObstaculos();
  jogo.prova = new Prova(jogo.sim);
  for (const mats of jogo.obstaculoMat.values()) for (const m of mats) m.emissive?.setHex(0);
  entrada.reiniciarCabine();
  hud.reiniciar();
}

async function mapaAutoescola(): Promise<THREE.Object3D> {
  const tex = await new THREE.TextureLoader().loadAsync(urlChao);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const raiz = criarMapaAutoescola({ textura: tex });
  decorarAutoescola(raiz);
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
renderer.domElement.addEventListener('pointerdown', (e) => { olhar.arrastando = true; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener('pointerup', () => (olhar.arrastando = false));
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!olhar.arrastando) return;
  olhar.yaw = Math.max(-2.4, Math.min(2.4, olhar.yaw - e.movementX * 0.004));
  olhar.pitch = Math.max(-0.8, Math.min(0.6, olhar.pitch - e.movementY * 0.004));
});
const camPos = new THREE.Vector3();
const camAlvo = new THREE.Vector3();
let camIniciada = false;

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
  if (modoCamera === 'cockpit') {
    jogo.visual.olho.getWorldPosition(camera.position);
    g.getWorldQuaternion(camera.quaternion);
    // Ao virar para trás, o tronco gira e a cabeça vai para o centro do carro.
    camera.position.add(new THREE.Vector3(-0.2, 0.07, -0.08).multiplyScalar(olhar.tras).applyQuaternion(camera.quaternion));
    camera.rotateY(Math.PI + olhar.yawSuave); // câmera olha para −Z; carro aponta +Z
    camera.rotateX(-0.06 + olhar.pitch);
    camera.fov = 68;
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
  if (e.code === 'F2') {
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

function comandosDe(ent: EstadoEntrada, desligar: boolean): Comandos {
  return {
    volante: ent.volante,
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

  const ent = entrada.ler(dt);
  const trem = jogo.sim.carro.trem;

  // Partida: apertar com o motor ligado desliga; segurar com ele desligado dá partida.
  let desligar = false;
  if (ent.partidaBorda && trem.ligado) {
    desligar = true;
    bloqueiaPartida = true;
  }
  if (!ent.partida) bloqueiaPartida = false;

  if (ent.bordas.has('camera')) modoCamera = MODOS[(MODOS.indexOf(modoCamera) + 1) % MODOS.length];
  if (ent.bordas.has('reiniciar')) reiniciarCarro();
  if (ent.bordas.has('encerrar')) jogo.prova.encerrar();

  const cabine = { seta: ent.seta, cinto: ent.cinto };
  if (!calibracao.estaAberta) {
    acumulador += dt;
    let primeiro = true;
    while (acumulador >= DT_FISICA) {
      const cmd = comandosDe(ent, desligar && primeiro);
      primeiro = false;
      jogo.sim.passo(cmd);
      const eventos = trem.eventos.splice(0);
      jogo.prova.atualizar(DT_FISICA, cmd, cabine, eventos);
      acumulador -= DT_FISICA;
    }
  }

  const t = jogo.sim.tempo;
  const piscando = Math.floor(t * 2.7) % 2 === 0;
  if ((ent.seta || ent.alerta) && piscando !== piscandoAnterior) som.clique();
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

  ceu.atualizarSombra(jogo.visual.grupo.position);
  atualizarCamera(dt, ent.olhar, ent.olharTras);
  som.atualizar(trem.rpm, trem.aceleradorEfetivo, trem.ligado, ent.partida && !bloqueiaPartida, CARRO.motor.cilindros);

  hud.atualizar(jogo.sim.carro, ent, jogo.prova, t, piscando, modoCamera, dt);
  const faltando = entrada.semCalibracao();
  hud.avisoCalibracao(faltando.length ? `“${faltando[0].id.slice(0, 40)}” não tem mapeamento conhecido — configure em F2` : null);

  if (modoCamera === 'cockpit') jogo.espelhos.render(renderer, cena);
  renderer.render(cena, camera);
}

// ---------- Início ----------
async function iniciar(): Promise<void> {
  await iniciarRapier();
  const params = new URLSearchParams(location.search);
  const glb = params.get('mapa');
  try {
    if (glb) await carregarGLB(glb);
    else carregarMapa(params.get('pista') === 'treino' ? criarMapaTeste() : await mapaAutoescola());
  } catch (err) {
    console.error(err);
    carregarMapa(criarMapaTeste());
  }
  requestAnimationFrame(quadro);

  const inicio = document.getElementById('inicio')!;
  const fecharInicio = () => {
    som.iniciar();
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
  inicio.querySelector<HTMLButtonElement>('[data-acao="treino"]')!.onclick = () => {
    fecharInicio();
    carregarMapa(criarMapaTeste());
  };
}

iniciar().catch((e) => {
  console.error(e);
  app.textContent = `Erro ao iniciar: ${e}`;
});
