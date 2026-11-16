/**
 * Material do chão da autoescola desenhado no shader a partir de campos.png
 * (cobertura de tinta branca, tinta amarela e piso elevado; ver scripts/gerar-mapa.mjs).
 *
 * A planta tem 1 px = 4,3 cm: usada direto como textura, cada pixel vira um quadrado
 * visível de perto (linhas serrilhadas, granulado em blocos). Aqui a cobertura borrada é
 * cortada em 0,5 com antisserrilhado de um pixel de tela, então as bordas ficam lisas em
 * qualquer distância; de longe (vários texels por pixel) usa a cobertura média, para as
 * linhas finas não sumirem. O granulado do asfalto, da grama e as juntas da calçada são
 * procedurais em metros, e somem com a distância antes de cintilar.
 */
import * as THREE from 'three';

export function materialChao(campos: THREE.Texture, largM: number, altM: number): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ map: campos, roughness: 0.92 });
  const img = campos.image as { width: number; height: number };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTexels = { value: new THREE.Vector2(img.width, img.height) };
    sh.uniforms.uMetros = { value: new THREE.Vector2(largM, altM) };
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec2 uTexels;
        uniform vec2 uMetros;
        float hashChao(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float ruidoChao(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hashChao(i), hashChao(i + vec2(1.0, 0.0)), f.x),
                     mix(hashChao(i + vec2(0.0, 1.0)), hashChao(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        // ruído com média 0, apagado quando o pixel cobre mais que meio período
        float detalhe(vec2 m, float freq, float pegada) {
          return (ruidoChao(m * freq) - 0.5) * (1.0 - smoothstep(0.25, 0.6, pegada * freq));
        }
        float corte(float c, float limiar, float longe) {
          float w = max(fwidth(c) * 0.75, 1e-3);
          float nitido = smoothstep(limiar - w, limiar + w, c);
          float medio = smoothstep(limiar - 0.4, limiar + 0.4, c);
          return mix(nitido, medio, longe);
        }
        vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }`,
      )
      .replace(
        '#include <map_fragment>',
        `vec3 cp = texture2D(map, vMapUv).rgb;
        vec2 tx = vMapUv * uTexels;
        float rho = max(length(dFdx(tx)), length(dFdy(tx)));   // texels por pixel de tela
        float longe = smoothstep(1.0, 3.0, rho);
        vec2 m = vMapUv * uMetros;                              // metros
        float pegada = rho * uMetros.x / uTexels.x;             // metros por pixel de tela

        // asfalto: manchas largas + grão fino
        float nAsf = detalhe(m, 0.35, pegada) * 0.10 + detalhe(m, 2.3, pegada) * 0.08 + detalhe(m, 11.0, pegada) * 0.07;
        vec3 cor = lin(vec3(0.235, 0.235, 0.245) * (1.0 + nAsf));

        // piso elevado: calçada (com juntas) e grama
        float calc = corte(cp.b, 0.25, longe);
        float grama = corte(cp.b, 0.75, longe);
        vec2 jt = (0.5 - abs(fract(m / 0.6) - 0.5)) * 0.6;      // distância até a junta (m)
        float wj = max(pegada, 1e-4);
        float junta = (1.0 - smoothstep(0.012, 0.012 + wj, min(jt.x, jt.y))) * (1.0 - smoothstep(0.02, 0.06, pegada));
        float nCalc = detalhe(m, 3.0, pegada) * 0.06 + detalhe(m, 0.6, pegada) * 0.05;
        vec3 corCalc = lin(vec3(0.78, 0.76, 0.72) * (1.0 + nCalc) * (1.0 - 0.18 * junta));
        float nGrama = detalhe(m, 0.5, pegada) * 0.18 + detalhe(m, 4.0, pegada) * 0.12 + detalhe(m, 17.0, pegada) * 0.10;
        vec3 corGrama = lin(vec3(0.37, 0.54, 0.30) * (1.0 + nGrama));
        cor = mix(cor, corCalc, calc);
        cor = mix(cor, corGrama, grama);

        // tintas (um pouco gastas)
        float gasto = 1.0 - 0.18 * smoothstep(0.55, 0.85, ruidoChao(m * 1.7)) * (1.0 - longe);
        float branco = corte(cp.r, 0.5, longe) * gasto;
        float amarelo = corte(cp.g, 0.5, longe) * gasto;
        cor = mix(cor, lin(vec3(0.93, 0.93, 0.91)), branco);
        cor = mix(cor, lin(vec3(0.96, 0.82, 0.14)), amarelo);
        diffuseColor.rgb *= cor;`,
      );
  };
  mat.customProgramCacheKey = () => 'chao-campos';
  return mat;
}
