import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import './style.css';
import { KWID } from './sim/carConfig';
import { Comandos } from './sim/powertrain';
import { DT_FISICA, iniciarRapier, Simulacao } from './sim/simulation';
import { lerMapa, Mapa } from './world/parser';
import { criarMapaTeste } from './world/testMap';
import { corSemaforo, CorSemaforo, Prova } from './exam/exam';
import { Entrada, EstadoEntrada } from './input/input';
import { Calibracao } from './input/calibration';
import { Hud } from './render/hud';
import { VisualCarro } from './render/carVisual';
import { Retrovisores } from './render/mirrors';
import { SomMotor } from './audio/engineSound';

type ModoCamera = 'externa' | 'cockpit' | 'cima';
const MODOS: ModoCamera[] = ['cockpit', 'externa', 'cima'];

const app = document.getElementById('app')!;

// ---------- Renderização ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
app.appendChild(renderer.domElement);

const cena = new THREE.Scene();
cena.background = new THREE.Color(0x9cc7e8);
cena.fog = new THREE.Fog(0x9cc7e8, 80, 260);

cena.add(new THREE.HemisphereLight(0xdfefff, 0x4a5a3a, 1.1));
const sol = new THREE.DirectionalLight(0xffffff, 2.2);
sol.castShadow = true;
sol.shadow.mapSize.set(2048, 2048);
const sc = sol.shadow.camera;
sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 150;
sol.shadow.bias = -0.0005;
cena.add(sol, sol.target);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 500);
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
  lampadas: { id: string; luzes: Record<CorSemaforo, THREE.MeshStandardMaterial>; sem: Mapa['semaforos'][number] }[];
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
      // Lâmpadas nos dois lados (quem vem de qualquer direção enxerga).
      for (const lado of [1, -1]) {
        const l = new THREE.Mesh(new THREE.CircleGeometry(0.1, 12), m);
        l.position.set(lado * 0.181, y, 0);
        l.rotation.y = (lado * Math.PI) / 2;
        caixa.add(l);
      }
      luzes[nome] = m;
    }
    mapa.raiz.add(caixa);
    out.push({ id: s.id, luzes, sem: s });
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
    if (m.isMesh) {
      m.receiveShadow = true;
      m.castShadow = true;
    }
  });
  const mapa = lerMapa(raiz);
  cena.add(raiz);
  const sim = new Simulacao(mapa, KWID);
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
    espelhos: new Retrovisores(visual.retrovisores),
    lampadas: montarSemaforos(mapa),
    obstaculoMat,
  };
  entrada.reiniciarCabine();
  hud.reiniciar();
}

function reiniciarCarro(): void {
  if (!jogo) return;
  jogo.sim.reposicionar();
  jogo.prova = new Prova(jogo.sim);
  for (const mats of jogo.obstaculoMat.values()) for (const m of mats) m.emissive?.setHex(0);
  entrada.reiniciarCabine();
  hud.reiniciar();
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
const olhar = { yaw: 0, pitch: 0, arrastando: false };
renderer.domElement.addEventListener('pointerdown', (e) => { olhar.arrastando = true; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener('pointerup', () => (olhar.arrastando = false));
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!olhar.arrastando) return;
  olhar.yaw = Math.max(-2.2, Math.min(2.2, olhar.yaw - e.movementX * 0.004));
  olhar.pitch = Math.max(-0.8, Math.min(0.6, olhar.pitch - e.movementY * 0.004));
});
const camPos = new THREE.Vector3();
const camAlvo = new THREE.Vector3();
let camIniciada = false;

function atualizarCamera(dt: number): void {
  if (!jogo) return;
  const g = jogo.visual.grupo;
  if (!olhar.arrastando) {
    olhar.yaw *= Math.exp(-dt * 2);
    olhar.pitch *= Math.exp(-dt * 2);
  }
  if (modoCamera === 'cockpit') {
    jogo.visual.olho.getWorldPosition(camera.position);
    g.getWorldQuaternion(camera.quaternion);
    camera.rotateY(Math.PI + olhar.yaw); // câmera olha para −Z; carro aponta +Z
    camera.rotateX(-0.08 + olhar.pitch);
    camera.fov = 70;
  } else {
    const frente = new THREE.Vector3(0, 0, 1).applyQuaternion(g.quaternion);
    frente.y = 0;
    frente.normalize();
    const alvoPos =
      modoCamera === 'externa'
        ? g.position.clone().addScaledVector(frente.applyAxisAngle(new THREE.Vector3(0, 1, 0), olhar.yaw), -6.5).add(new THREE.Vector3(0, 2.4, 0))
        : g.position.clone().add(new THREE.Vector3(0, 22, 0)).addScaledVector(frente, -0.01);
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
  if (ent.seta && piscando !== piscandoAnterior) som.clique();
  piscandoAnterior = piscando;

  // Visual
  jogo.visual.atualizar(jogo.sim.carro, ent.freio > 0.05, ent.seta, piscando, modoCamera === 'cockpit');
  for (const l of jogo.lampadas) {
    const cor = corSemaforo(l.sem, t);
    for (const k of Object.keys(l.luzes) as CorSemaforo[]) l.luzes[k].emissiveIntensity = k === cor ? 2.5 : 0.05;
  }
  for (const o of jogo.prova.obstaculosTocados) for (const m of jogo.obstaculoMat.get(o) ?? []) m.emissive?.setHex(0x880000);

  const p = jogo.visual.grupo.position;
  sol.position.set(p.x + 30, p.y + 60, p.z + 20);
  sol.target.position.copy(p);

  atualizarCamera(dt);
  som.atualizar(trem.rpm, trem.aceleradorEfetivo, trem.ligado, ent.partida && !bloqueiaPartida);

  hud.atualizar(jogo.sim.carro, ent, jogo.prova, t, piscando, modoCamera);
  const faltando = entrada.semCalibracao();
  hud.avisoCalibracao(faltando.length ? `“${faltando[0].id.slice(0, 40)}” ainda não foi calibrado — aperte F2` : null);

  renderer.render(cena, camera);
  if (modoCamera === 'cockpit') jogo.espelhos.render(renderer, cena, window.innerWidth, window.innerHeight);
}

// ---------- Início ----------
async function iniciar(): Promise<void> {
  await iniciarRapier();
  const param = new URLSearchParams(location.search).get('mapa');
  if (param) {
    try {
      await carregarGLB(param);
    } catch (err) {
      console.error(err);
      carregarMapa(criarMapaTeste());
    }
  } else {
    carregarMapa(criarMapaTeste());
  }
  requestAnimationFrame(quadro);

  const inicio = document.getElementById('inicio')!;
  inicio.querySelector<HTMLButtonElement>('[data-acao="jogar"]')!.onclick = () => {
    som.iniciar();
    inicio.classList.add('oculto');
  };
  inicio.querySelector<HTMLButtonElement>('[data-acao="calibrar"]')!.onclick = () => {
    som.iniciar();
    inicio.classList.add('oculto');
    calibracao.abrir();
  };
}

iniciar().catch((e) => {
  console.error(e);
  app.textContent = `Erro ao iniciar: ${e}`;
});
