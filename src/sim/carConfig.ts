/**
 * Parâmetros físicos de um carro. Unidades SI (m, kg, s, N, N·m, rad/s).
 *
 * Referencial local do carro (igual ao do three.js):
 *   +Z = frente, +Y = cima, +X = esquerda.
 *   A origem do corpo rígido é o centro de massa (CG).
 */
export interface CarConfig {
  nome: string;

  massa: number;              // kg, já com o motorista
  /** Momento de inércia principal em torno de X (arfagem), Y (guinada) e Z (rolagem). */
  inercia: [number, number, number];
  alturaCG: number;           // altura do CG em relação ao chão, parado

  /** Caixa de colisão da carroceria, relativa ao CG. */
  carroceria: { meiaLargura: number; meiaAltura: number; meiaComprimento: number; centro: [number, number, number] };

  eixoDianteiroZ: number;     // distância do CG ao eixo dianteiro (+)
  eixoTraseiroZ: number;      // distância do CG ao eixo traseiro (−)
  bitolaDianteira: number;
  bitolaTraseira: number;

  roda: {
    raio: number;
    inercia: number;          // kg·m² por roda (roda + pneu + parte do semi-eixo)
  };

  suspensao: {
    cursoMax: number;         // comprimento máximo (montagem → centro da roda), m
    molaDianteira: number;    // N/m
    molaTraseira: number;
    amortecedorDianteiro: number; // N·s/m
    amortecedorTraseiro: number;
    batenteCurso: number;     // abaixo desse comprimento, o batente entra
    batenteRigidez: number;
  };

  pneu: {
    mu: number;               // coeficiente de atrito pico
    /** Pacejka simplificado (lateral): F = D·sin(C·atan(B·α)) */
    B: number;
    C: number;
    rigidezLongitudinal: number;   // N por unidade de slip ratio
    rigidezCerdaLong: number;      // N/m — “cerda” para atrito estático (segurar na rampa)
    rigidezCerdaLat: number;
    resistenciaRolagem: number;    // Crr
    rastro: number;                // m, rastro pneumático (torque autoalinhante → FFB)
  };

  direcao: {
    voltasBatenteABatente: number; // voltas do volante do carro
    anguloMaxRoda: number;         // rad
  };

  motor: {
    cilindros: number;
    inercia: number;          // kg·m² (virabrequim + volante)
    rpmMarchaLenta: number;
    rpmApaga: number;         // abaixo disso o motor morre
    rpmPega: number;          // com o motor de partida girando acima disso, o motor pega
    rpmTranco: number;        // sem motor de partida (no tranco), precisa girar acima disso
    rpmCorte: number;         // limitador
    /** Curva de torque em plena carga: [rpm, N·m] */
    curvaTorque: [number, number][];
    /** Atrito interno / freio-motor: T = a + b·ω + c·ω² */
    atrito: [number, number, number];
    atritoDesligado: number;  // N·m, compressão + atrito com motor parado
    torqueMotorPartida: number;
    marchaLentaMaxAcelerador: number; // autoridade máxima do controle de marcha lenta (0–1)
  };

  embreagem: {
    torqueMax: number;        // capacidade com o pedal solto
    /** Fração do pedal SOLTO (0 = pedal no fundo) onde começa a pegar e onde trava. */
    inicioPega: number;
    fimPega: number;
    expoente: number;
  };

  cambio: {
    relacoes: number[];       // 1ª..5ª
    re: number;
    diferencial: number;
    eficiencia: number;       // perdas no câmbio/diferencial
  };

  freio: {
    torqueMaxDianteiro: number; // por roda
    torqueMaxTraseiro: number;
    freioDeMao: number;         // por roda traseira
  };

  aero: { cdA: number };
}

/**
 * Renault Kwid 1.0 SCe (3 cilindros), câmbio manual de 5 marchas.
 *
 * Massa, dimensões, potência e torque vêm da ficha técnica pública (aproximados).
 * Relações de marcha, inércias, curva de torque completa e embreagem são
 * ESTIMATIVAS plausíveis para um 1.0 popular — confira com o manual/ficha
 * técnica e ajuste pela sensação ao volante.
 */
export const KWID: CarConfig = {
  nome: 'Renault Kwid 1.0 (aprox.)',

  massa: 860,
  inercia: [1050, 1150, 300],
  alturaCG: 0.55,

  // Comprimento 3,68 m; largura 1,58 m; balanços ~0,65 m (frente) e ~0,61 m (trás).
  carroceria: { meiaLargura: 0.78, meiaAltura: 0.42, meiaComprimento: 1.84, centro: [0, 0.2, -0.22] },

  // Entre-eixos 2,42 m, ~60% do peso na frente.
  eixoDianteiroZ: 0.97,
  eixoTraseiroZ: -1.45,
  bitolaDianteira: 1.39,
  bitolaTraseira: 1.38,

  roda: { raio: 0.293, inercia: 0.9 }, // 165/70 R14

  suspensao: {
    cursoMax: 0.3,
    molaDianteira: 20000,
    molaTraseira: 16000,
    amortecedorDianteiro: 1700,
    amortecedorTraseiro: 1400,
    batenteCurso: 0.06,
    batenteRigidez: 150000,
  },

  pneu: {
    mu: 0.95,
    B: 9,
    C: 1.4,
    rigidezLongitudinal: 40000,
    rigidezCerdaLong: 60000,
    rigidezCerdaLat: 60000,
    resistenciaRolagem: 0.012,
    rastro: 0.035,
  },

  direcao: { voltasBatenteABatente: 3.0, anguloMaxRoda: (35 * Math.PI) / 180 },

  motor: {
    cilindros: 3,
    inercia: 0.12,
    rpmMarchaLenta: 850,
    rpmApaga: 320,
    rpmPega: 180,
    rpmTranco: 550,
    rpmCorte: 6400,
    // Ficha: 68 cv @ 5500 rpm e 9,4 kgf·m (≈92 N·m) @ 4250 rpm (gasolina).
    curvaTorque: [
      [0, 40], [500, 55], [1000, 70], [1500, 76], [2000, 82], [2500, 86], [3000, 89],
      [3500, 91], [4250, 92], [5000, 89.5], [5500, 87], [6000, 80], [6500, 70], [7000, 50],
    ],
    atrito: [8, 0.025, 0.00004],
    atritoDesligado: 22,
    torqueMotorPartida: 45,
    marchaLentaMaxAcelerador: 0.2,
  },

  embreagem: { torqueMax: 135, inicioPega: 0.3, fimPega: 0.75, expoente: 1.6 },

  cambio: {
    relacoes: [3.727, 2.048, 1.393, 1.029, 0.795],
    re: 3.545,
    diferencial: 4.21,
    eficiencia: 0.92,
  },

  // Freio de mão ~0,25 g: segura a rampa, mas dá pra sair arrastando (falta comum!).
  freio: { torqueMaxDianteiro: 1300, torqueMaxTraseiro: 600, freioDeMao: 320 },

  aero: { cdA: 0.72 },
};

export const RPM_PARA_RADS = (2 * Math.PI) / 60;
