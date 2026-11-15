# Simulador de prova prática (DETRAN)

three.js + Rapier + física própria de carro manual (Renault Kwid 1.0). Gráficos low-poly; o foco é a física e a mecânica.

```bash
npm install
npm run dev      # abre em http://localhost:5173 (use Chrome/Chromium)
npm test         # testes de física e da prova (headless, Node)
```

## Estrutura

| Pasta | O quê |
|---|---|
| `src/sim/carConfig.ts` | Todos os parâmetros do carro (massa, curva de torque, marchas, embreagem, pneus, suspensão). Para outro carro (ex.: Mobi), crie outro objeto `CarConfig`. |
| `src/sim/powertrain.ts` | Motor (marcha lenta, freio-motor, apagar, partida, tranco), embreagem com patinagem, câmbio (arranha sem embreagem), diferencial aberto, giro das rodas e força longitudinal dos pneus. Roda a 1 kHz. Não depende de Rapier: dá pra testar isolado. |
| `src/sim/vehicle.ts` | Suspensão por raycast, pneu lateral (Pacejka simplificado + “cerdas” para não escorregar parado), Ackermann, arrasto. Aplica forças no corpo rígido do Rapier. |
| `src/sim/simulation.ts` | Mundo Rapier a 200 Hz. |
| `src/world/parser.ts` | Lê qualquer cena three.js/GLB pelas **convenções de nome** abaixo. |
| `src/world/testMap.ts` | Mapa de teste feito em código, com as mesmas convenções (serve de exemplo). |
| `src/exam/regras.ts` | Tabela de faltas, gravidade, pontos e limite. **Confira com a resolução do CONTRAN vigente.** |
| `src/exam/exam.ts` | Avaliador: detecta as faltas a cada passo da física. |
| `src/input/` | Teclado + Gamepad API (controle, G29, câmbio H) e a tela de calibração (F2). |
| `src/render/`, `src/audio/` | Carro low-poly, cockpit com volante girando, retrovisores, HUD, som do motor sintetizado. |

## Mapas no Blender

Modele normalmente e exporte em **glTF Binary (.glb)** com *+Y Up* (padrão do exportador). Marque **Include → Custom Properties** para as propriedades (`visivel`, tempos do semáforo) irem junto. Depois, **arraste o .glb para a janela do jogo** ou abra `?mapa=/caminho/arquivo.glb` (coloque o arquivo em `public/`).

O jogo entende os objetos pelo **nome**:

| Nome | Função |
|---|---|
| `COL_<qualquer>` | Colisor (malha estática). Fica **invisível**, a não ser que tenha a propriedade customizada `visivel = 1`. Use malhas simples. |
| `COL_calcada_*` / `COL_meiofio_*` | Calçada: a roda encostar = falta. |
| `BALIZA_<n>` | Haste da baliza (tocar = falta). |
| `CONE_<n>` | Cone (tocar = falta). |
| `ZONA_BALIZA` | Caixa da vaga. O carro precisa terminar inteiro dentro, parado. O cronômetro começa quando você engata a ré perto dela. |
| `ZONA_RAMPA` | Caixa cobrindo a subida. Parar e recuar mais de 40 cm = falta. |
| `FAIXA_PEDESTRE_<n>` | Caixa da faixa. Parar em cima = falta. |
| `SEMAFORO_<id>` | Poste; o jogo cria as luzes em cima. Propriedades opcionais: `verde`, `amarelo`, `vermelho` (s), `defasagem`. |
| `LINHA_PARADA_<id>` | Linha de retenção do `SEMAFORO_<id>`. Cruzar no vermelho = eliminatória. |
| `SPAWN_CARRO` | Empty onde o carro nasce, **apontando para o +Y do Blender** (seta verde). |

Zonas são caixas (o jogo usa o bounding box do objeto, com rotação e escala) e ficam invisíveis. Maiúsculas e minúsculas não importam, e o sufixo `.001` do Blender é ignorado. A malha visual e a de colisão podem ser objetos diferentes: o visual pode ficar bonito sem afetar a física.

## Volante G29

- No PC, chave na posição **PS3**. No Linux, o kernel (`hid-logitech`) já reconhece.
- Abra a calibração com **F2** e siga o assistente: gire, pise em cada pedal, engate cada marcha do câmbio H e aperte os botões. Fica salvo no navegador.
- A rotação do G29 (900°) é mapeada no curso total do volante do carro (3 voltas).

## Próximos passos

- **Force feedback via WebHID** (só Chrome). `Veiculo.torqueAutoalinhante` já tem o torque autoalinhante para alimentar o FFB. No Linux é preciso uma regra udev que libere o `hidraw` do G29 para o seu usuário.
- Conferir e ajustar `regras.ts` com a resolução atual.
- Relações de marcha e curva de torque reais do Kwid ou do Mobi (ficha técnica/manual).
- Percurso guiado (“examinador” dando instruções) e mais mapas.
