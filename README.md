# Simulador de prova prática (DETRAN)

three.js + Rapier + física própria de carro manual (Fiat Mobi 1.0; também tem o Renault Kwid 1.0). O foco é a física e a mecânica.

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
| `src/world/autoescola.ts` | Pista da autoescola, gerada da planta (`assets-fonte/mapa-autoescola.png`) por `node scripts/gerar-mapa.mjs`: textura do chão + grade de calçadas/meio-fio (15 cm). Baliza, faixas de pedestre, zonas de PARE e spawn ficam aqui. |
| `src/world/autoescolaDecoracao.ts` | Placas (CTB), árvores e prédios da pista da autoescola. |
| `src/world/placas.ts`, `src/world/ambiente.ts` | Placas de trânsito brasileiras e cenário (árvores, prédios, céu). |
| `src/exam/regras.ts` | Tabela de faltas e pontos pela Resolução CONTRAN nº 1.020/2025 (leve 1, média 2, grave 4, gravíssima 6; aprovado com até 10 pontos; sem eliminatória). Faltas que não são infração do CTB têm peso escolhido por nós (marcado no arquivo). |
| `src/exam/examinador.ts`, `src/exam/pista.ts` | Examinador com percurso (11 etapas, voz em português) e regras de faixa: contramão, linha divisória, conversão sem seta. |
| `src/render/relatorio.ts` | Relatório no fim da prova: faltas, mapa com trajeto e histórico das tentativas. |
| `src/world/vias.ts` | Linhas centrais das faixas (gerado por `node scripts/gerar-vias.mjs`). |
| `src/world/autoescola/divisoria.json` | Centro da linha amarela contínua do anel, medido na textura (`node scripts/gerar-divisoria.mjs`). A falta de transpor a linha usa ele: conta quando o pneu passa da tinta. |
| `src/world/chaoShader.ts`, `src/world/autoescola/campos.png` | Chão desenhado no shader: `campos.png` (gerado junto com `chao.png`) guarda a cobertura de tinta branca/amarela e de calçada/grama; o shader corta as bordas com antisserrilhado e põe granulado do asfalto, grama e juntas da calçada em metros. `chao.png` continua sendo usado no mapa do relatório e pelos scripts. |
| `src/world/trafego.ts` | Carros e pedestres controlados pelo jogo. |
| `src/world/modelosCarros.ts`, `public/carros/` | Carros do trânsito: [Car Kit da Kenney](https://kenney.nl/assets/car-kit) (CC0). Cor da pintura trocada no shader (célula do atlas), lanternas acendem no freio, setas nos cantos. Nos testes (sem navegador) o trânsito usa os carros simples. |
| `src/audio/somCarro.ts` | Som sintetizado do motor, pneus, rodagem e eventos (marcha, freio de mão, cinto, seta, batida). |
| `src/render/opcoes.ts` | Menu de opções (tecla O): carro, volante, horário (dia/entardecer/noite), qualidade, som. |
| `src/treino/*`, `src/render/treinoUi.ts` | Treino guiado (tecla T): conhecer o carro, sair/trocar/parar, placas, rampa e baliza com referências. |
| `src/world/ferrovia.ts`, `src/audio/somFerrovia.ts` | Passagem de nível: trem, cancelas, luzes, sino e buzina. |
| `src/world/iluminacao.ts` | Iluminação pública noturna. |
| `src/exam/exam.ts` | Avaliador: detecta as faltas a cada passo da física. |
| `src/input/` | Teclado + Gamepad API (controle, G29, câmbio H) e a tela de calibração (F2). |
| `src/input/toque.ts` | Celular/tablet: pedais analógicos na tela (dedo mais alto = mais fundo), volante na tela ou inclinando o aparelho, câmbio em H, botões. Liga sozinho em tela de toque (Opções → Celular / tablet); `?toque=1` força no PC. |
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
| `ZONA_PARE_<n>` | Área antes de uma placa PARE (o eixo +Z local aponta no sentido da via). Sair pela frente sem ter parado = falta. |
| `FAIXA_PEDESTRE_<n>` | Caixa da faixa. Parar em cima = falta. |
| `SEMAFORO_<id>` | Poste; o jogo cria as luzes em cima. Propriedades opcionais: `verde`, `amarelo`, `vermelho` (s), `defasagem`. |
| `LINHA_PARADA_<id>` | Linha de retenção do `SEMAFORO_<id>`. Cruzar no vermelho = eliminatória. |
| `SPAWN_CARRO` | Empty onde o carro nasce, **apontando para o +Y do Blender** (seta verde). |

Objetos com a propriedade customizada `colisor` (`{raio, altura}` ou `{meiaLargura, meiaAltura, meiaProfundidade}`) viram sólidos em que o carro bate (postes, árvores, muros). Cones e balizas são soltos: caem se o carro bater.

Zonas são caixas (o jogo usa o bounding box do objeto, com rotação e escala) e ficam invisíveis. Maiúsculas e minúsculas não importam, e o sufixo `.001` do Blender é ignorado. A malha visual e a de colisão podem ser objetos diferentes: o visual pode ficar bonito sem afetar a física.

## Volante G29

- No PC, chave na posição **PS3**. Já vem mapeado (Windows e Linux), sem calibrar: pedais, câmbio H (marchas 1–5 e ré), borboletas = setas, X freio de mão, △ partida, □ cinto, ○ farol, L2 pisca-alerta, R2 câmera, Share reinicia, Options encerra, direcional olha para os lados, L3 olha para trás.
- Em **F2** fica a tabela ação → eixo/botão, com o valor ao vivo. Dá pra **mudar um comando de cada vez**, inverter um eixo ou remover. Fica salvo no navegador.
- O volante do Mobi tem 2,5 voltas de batente a batente (900°), igual ao G29: a rotação é 1:1.

## Próximos passos

- **Force feedback via WebHID** (só Chrome). `Veiculo.torqueAutoalinhante` já tem o torque autoalinhante para alimentar o FFB. No Linux é preciso uma regra udev que libere o `hidraw` do G29 para o seu usuário.
- Conferir e ajustar `regras.ts` com a resolução atual.
- Relações de marcha e curva de torque reais do Kwid ou do Mobi (ficha técnica/manual).
- Percurso guiado (“examinador” dando instruções) e mais mapas.
