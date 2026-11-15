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
    /** Barra estabilizadora (rigidez na roda, N/m): resiste à diferença de compressão esquerda/direita. */
    barraDianteira: number;
    barraTraseira: number;
    /** Altura do centro de rolagem (m acima do chão): onde as forças do pneu “entram” no chassi. */
    centroRolagemDianteiro: number;
    centroRolagemTraseiro: number;
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
    relaxacao: number;             // m, comprimento de relaxação lateral (o pneu leva ~isso para criar força)
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
    barraDianteira: 16000,
    barraTraseira: 9000,
    centroRolagemDianteiro: 0.06,
    centroRolagemTraseiro: 0.14,
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
    relaxacao: 0.35,
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

/**
 * Fiat Mobi 1.0 Fire Evo (4 cilindros, 8V), câmbio manual de 5 marchas (C513).
 *
 * Ficha: 3,566 m × 1,633 m × 1,502 m; entre-eixos 2,305 m; ~933 kg em ordem de
 * marcha; 71 cv @ 6250 rpm e 9,5 kgf·m (≈93 N·m) @ 3850 rpm (gasolina);
 * pneus 175/65 R14; ré 3,909 e diferencial 4,2.
 * As relações de 1ª a 5ª e o resto (inércias, curva completa, embreagem) são
 * ESTIMATIVAS — confira no manual.
 */
export const MOBI: CarConfig = {
  ...KWID,
  nome: 'Fiat Mobi 1.0 (aprox.)',
  massa: 1010, // 933 kg + motorista
  inercia: [1150, 1250, 330],
  alturaCG: 0.56,
  // Comprimento 3,566 m; largura 1,633 m; balanços ~0,70 m (frente) e ~0,56 m (trás).
  carroceria: { meiaLargura: 0.8, meiaAltura: 0.42, meiaComprimento: 1.78, centro: [0, 0.2, -0.16] },
  // Entre-eixos 2,305 m, ~61% do peso na frente.
  eixoDianteiroZ: 0.9,
  eixoTraseiroZ: -1.405,
  bitolaDianteira: 1.41,
  bitolaTraseira: 1.4,
  roda: { raio: 0.292, inercia: 0.95 }, // 175/65 R14
  suspensao: {
    ...KWID.suspensao,
    molaDianteira: 23000,
    molaTraseira: 18000,
    amortecedorDianteiro: 2300,
    amortecedorTraseiro: 1900,
    barraDianteira: 12000,
    barraTraseira: 6000,
  },
  // 2,5 voltas = 900°: casa 1:1 com o G29.
  direcao: { voltasBatenteABatente: 2.5, anguloMaxRoda: (36 * Math.PI) / 180 },
  motor: {
    ...KWID.motor,
    cilindros: 4,
    inercia: 0.13,
    rpmMarchaLenta: 850,
    rpmCorte: 6600,
    curvaTorque: [
      [0, 40], [500, 55], [1000, 72], [1500, 79], [2000, 84], [2500, 88], [3000, 91],
      [3850, 93], [4500, 91], [5000, 88.5], [5500, 85], [6250, 79], [6800, 68], [7200, 50],
    ],
  },
  cambio: {
    relacoes: [4.273, 2.238, 1.444, 1.029, 0.838],
    re: 3.909,
    diferencial: 4.2,
    eficiencia: 0.92,
  },
};
