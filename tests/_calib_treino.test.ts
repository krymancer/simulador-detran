import { beforeAll, it } from 'vitest';
import { MOBI } from '../src/sim/carConfig';
import { COMANDOS_NEUTROS, Comandos } from '../src/sim/powertrain';
import { iniciarRapier, Simulacao, HZ_FISICA } from '../src/sim/simulation';
import { lerMapa } from '../src/world/parser';
import { criarMapaAutoescola } from '../src/world/autoescola';
beforeAll(async () => { await iniciarRapier(); });
it('calib', () => {
  const sim = new Simulacao(lerMapa(criarMapaAutoescola()), MOBI);
  const run = (s: number, c: (t: number) => Partial<Comandos>, log?: (t: number) => void) => {
    const t0 = sim.tempo; let k = 0;
    for (let i = 0; i < s * HZ_FISICA; i++) { const t = sim.tempo - t0; sim.passo({ ...COMANDOS_NEUTROS, ...c(t) }); if (log && k++ % 40 === 0) log(t); }
  };
  run(1, () => ({ partida: true, embreagem: 1 }));
  run(2, () => ({ embreagem: 1 }));
  const tr = sim.carro.trem;
  console.log('idle', tr.rpm.toFixed(0), tr.ligado);
  run(1, () => ({ embreagem: 1, marcha: 1 }));
  run(10, (t) => ({ embreagem: Math.max(0.3, 0.75 - t * 0.04), marcha: 1, freioDeMao: true }), (t) =>
    console.log(t.toFixed(1), 'emb', Math.max(0.3, 0.75 - t * 0.04).toFixed(2), 'rpm', tr.rpm.toFixed(0), 'cap', tr.capacidadeEmbreagem.toFixed(1), 'Tc', tr.torqueEmbreagem.toFixed(1), tr.ligado, 'v', sim.carro.velocidadeLongitudinal().toFixed(2)));
});
