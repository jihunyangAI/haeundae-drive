import { Matrix4 } from 'three';

// Values every city material reads, driven by the weather and the time of day (see atmosphere.js).
export const ENV = {
  snow: { value: 0 },      // 0..1 snow lying on flat surfaces
  night: { value: 0 },     // 0..1 how strongly lit windows show
  wet: { value: 0 },       // 0..1 water standing on the carriageway
  mirror: { value: null }, // the scene mirrored in the road (see reflection.js) and the matrix that looks it up
  mirrorMatrix: { value: new Matrix4() },
};

const SNOW_COLOUR = 'vec3(0.86, 0.89, 0.93)';

// Let snow settle on a material. `amount` is how white it gets under full cover (roads stay slushy).
export function snowable(material, amount) {
  material.onBeforeCompile = shader => {
    shader.uniforms.uSnow = ENV.snow;
    shader.fragmentShader = `uniform float uSnow;\n${shader.fragmentShader}`.replace(
      '#include <color_fragment>',
      `#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, ${SNOW_COLOUR}, uSnow * ${amount.toFixed(2)});`,
    );
  };
  material.customProgramCacheKey = () => `snow${amount}`;
  return material;
}

// A carriageway: slushy under snow, and when wet it shows the mirrored scene, strongest at a glancing
// angle and smeared towards the viewer the way lights stretch on wet tarmac.
export function wetRoad(material, snow) {
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, { uSnow: ENV.snow, uWet: ENV.wet, uMirror: ENV.mirror, uMirrorMatrix: ENV.mirrorMatrix });
    shader.vertexShader = `uniform mat4 uMirrorMatrix;\nvarying vec4 vMirror;\nvarying vec3 vRoadPos;\n${shader.vertexShader}`.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
  vRoadPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vMirror = uMirrorMatrix * vec4(vRoadPos, 1.0);`,
    );
    shader.fragmentShader = `uniform float uSnow, uWet;
uniform sampler2D uMirror;
varying vec4 vMirror;
varying vec3 vRoadPos;
float roadNoise(vec2 p) { return fract(sin(dot(floor(p), vec2(12.9898, 78.233))) * 43758.5453); }
${shader.fragmentShader}`.replace(
      '#include <color_fragment>',
      `#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, ${SNOW_COLOUR}, uSnow * ${snow.toFixed(2)});`,
    ).replace(
      '#include <opaque_fragment>',
      `if (uWet > 0.01) {
    vec2 uv = vMirror.xy / vMirror.w;
    // uneven film of water: break the picture up a little, patchy from place to place
    vec2 grain = vec2(roadNoise(vRoadPos.xz * 9.0), roadNoise(vRoadPos.zx * 9.0 + 7.0)) - 0.5;
    float puddle = 0.55 + 0.45 * roadNoise(vRoadPos.xz * 0.35);
    uv += grain * 0.006;
    vec3 seen = vec3(0.0);
    for (int i = 0; i < 5; i++) seen += texture2D(uMirror, uv + vec2(0.0, float(i) * 0.012)).rgb;
    float glance = 1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
    outgoingLight += seen * 0.2 * uWet * puddle * (0.06 + 0.94 * pow(glance, 3.0)) * (1.0 - uSnow * 0.7);
  }
  #include <opaque_fragment>`,
    );
  };
  material.customProgramCacheKey = () => `wetroad${snow}`;
  return material;
}

// Lit windows for a tiled facade. The material's emissive map marks the glazing of one tile; each
// tile (one bay of one floor) is switched on or off by a hash, so the pattern differs per building.
// `lit` is the share of windows that are on.
export function nightWindows(material, lit) {
  material.onBeforeCompile = shader => {
    shader.uniforms.uNight = ENV.night;
    shader.fragmentShader = `uniform float uNight;\n${shader.fragmentShader}`.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
  {
    vec2 cell = floor(vEmissiveMapUv) + floor(vColor.r * vec2(977.0, 1583.0));
    float seed = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
    float on = step(seed, ${lit.toFixed(2)});
    vec3 tint = mix(vec3(1.0, 0.76, 0.46), vec3(0.78, 0.9, 1.0), step(0.78, fract(seed * 91.7)));
    totalEmissiveRadiance *= on * tint * uNight * (0.45 + 0.75 * fract(seed * 53.3));
  }`,
    );
  };
  material.customProgramCacheKey = () => `night${lit}`;
  return material;
}
