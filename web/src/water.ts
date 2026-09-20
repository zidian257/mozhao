import { prefersReducedMotion } from './reduced-motion';

// 环境水景 + 泡泡：raw WebGL2 全屏三角形，单 pass fragment shader。
// 背景分层（自底向上）：深度 ramp × 极光色场 → 斯涅尔窗口光 → 双色光柱 → 细丝焦散
// → 三色景深微粒。背景独立成 background()：泡泡内部按球面法线偏移重采样（逐通道
// 色散），画面真正"穿过"泡体，而非贴一层半透明渐变。
// 泡泡分层：膜边界三列慢正弦 → 折射透镜（色散）→ 菲涅尔薄膜干涉虹彩（余弦色盘，
// 随时间/浮动流转）→ 双柔高光 + 底部聚光弧 → 外圈呼吸晕。录音态 rec 0→1：
// 膜起伏收拢、虹彩淡出、径向红核淡入（收缩/透明度由 DOM 键的 motion 弹簧经
// getBoundingClientRect 每帧同步，shader 只负责作画）。
// uniform 接口：
//   uRes(vec2)        画布物理像素尺寸
//   uTime(float)      秒
//   uRipples[8](vec4) x=uv.x, y=uv.y, z=起始时刻(秒), w=强度（0 为空闲槽）
//   uGrain(float)     胶片颗粒幅度（桌面 0.010；触屏 0——高 PPI OLED 上 6fps 重播种呈雪花闪烁）
//   uBubblePos(vec2)  泡泡中心（p 空间：x 已乘 aspect，y 向上）
//   uBubbleRad(vec2)  泡泡半径（p 空间，xy 分离——浮动晃动的等积形变呈微椭）
//   uBubbleMix(vec3)  x=录音态 0..1，y=整体透明度，z=浮动视差相位（虹彩/高光随动）
// 涟漪为解析式衰减波叠加：环形高斯包络外扩 + 正弦相位 → 采样位移（扭曲焦散/光柱）+ 微光。
// 构图：p 空间按画布高度归一（x = uv.x*aspect），圆形距离各向同性，任意宽高比不变形；
// 斯涅尔窗/光柱/焦散均锚定顶中，竖屏天然成立。
// 图案尺度（焦散/微粒）锚定短边 ps = p / min(aspect,1)：竖屏手机上若按屏高归一，
// 细丝光网会被放大成满屏云团——按短边归一后，任何设备上图案密度一致。
// 移动端保护（pointer: coarse）：颗粒归零（dither 保留防色带）。全平台 60fps、DPR 封顶 2。
// resize：地址栏伸缩会高频触发，只做 150ms 防抖后的 buffer 重设——过渡期旧 buffer 被 CSS
// 软拉伸，无重 alloc 跳变。监听 window resize + visualViewport.resize。
// 降级：WebGL2 不可用 / 编译失败 → 返回 inactive（调用方回退 CSS 渐变与 CSS 泡膜）；
//       reduced-motion → 静态单帧（uTime 固定，无漂移、无涟漪、颗粒定格）。

const MAX_RIPPLES = 8;
const STATIC_TIME = 24;

const VERT = `#version 300 es
void main() {
  vec2 v = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;

uniform vec2 uRes;
uniform float uTime;
uniform vec4 uRipples[8];
uniform float uGrain;
uniform vec2 uBubblePos;
uniform vec2 uBubbleRad;
uniform vec3 uBubbleMix;
uniform vec4 uOff; // 分层开关（远程诊断用）：x=光柱 y=焦散 z=极光 w=微粒
uniform float uOffDither;

out vec4 fragColor;

// Hash without Sine（Dave Hoskins）：小乘数、中间量有界——
// 经典 hash21 的 fract(p*234.34) 在部分移动 GPU（Mali/Immortalis）上会因
// 大数精度崩塌退化成竖直条纹、噪声断裂；此版本在桌面与移动端行为一致。
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 32 位无符号整数位混合（lowbias32）：与浮点精度彻底无关。
// 逐像素抖动/颗粒以 gl_FragCoord（上千）为种子，浮点哈希在这种大坐标下
// 于部分移动 GPU 上会退化成规则细格——整数路径在任何 GPU 上逐位一致。
uint uhash(uint h) {
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}

// 周期 32 无缝包裹：坐标与格点同周期取模，跨缝连续。所有噪声输入（含随运行
// 时间无限增长的相位项）永远收在 [0,32)——低精度单元上小数位也不丢；
// 场上最大跨度 ~14，周期 32 的重复在屏外，视觉上无差
float vnoise(vec2 p) {
  p = mod(p, 32.0);
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(mod(i, 32.0)), hash21(mod(i + vec2(1.0, 0.0), 32.0)), u.x),
    mix(hash21(mod(i + vec2(0.0, 1.0), 32.0)), hash21(mod(i + vec2(1.0, 1.0), 32.0)), u.x),
    u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return v;
}

// 极光色场：三路低频 vnoise 驱动四色（青碧/紫藤/蔷薇/蜜金）缓慢流转。
// 空间频率取到屏面 ~2-3 个色区共存——同一时刻青/紫/蔷薇同框（Apple 式多彩），
// 而非整屏单色轮换；单 octave，成本远低于 fbm
vec3 aurora(vec2 p, float t) {
  float n1 = vnoise(p * 1.7 + vec2(t * 0.021, -t * 0.013));
  float n2 = vnoise(p * 1.4 + vec2(-t * 0.017, t * 0.019) + 3.7);
  float n3 = vnoise(p * 1.1 + vec2(t * 0.009, t * 0.012) + 9.1);
  vec3 a = mix(vec3(0.30, 0.70, 0.78), vec3(0.50, 0.38, 0.86), smoothstep(0.15, 0.85, n1)); // 青碧→紫藤
  vec3 b = mix(vec3(0.86, 0.42, 0.62), vec3(0.93, 0.64, 0.34), smoothstep(0.20, 0.80, n2)); // 蔷薇→蜜金
  return mix(a, b, smoothstep(0.25, 0.75, n3));
}

// 背景全层。独立成函数：泡泡按折射偏移重采样它（逐通道色散），画面真正穿过泡体
vec3 background(vec2 q, float aspect, float t) {
  vec2 quv = vec2(q.x / aspect, q.y);
  float up = clamp(quv.y, 0.0, 1.0);
  // 短边归一图案坐标：qs = q / min(aspect, 1)，竖屏与桌面图案密度一致
  vec2 qs = q / min(aspect, 1.0);

  // 深度 ramp 整体提亮、底部透紫；再与极光色场混合——上部近光处色彩最盛，下部收敛留深邃
  vec3 cTop = vec3(0.320, 0.480, 0.510);
  vec3 cMid = vec3(0.270, 0.340, 0.440);
  vec3 cBot = vec3(0.210, 0.220, 0.340);
  vec3 ramp = mix(cBot, cMid, smoothstep(0.0, 0.55, up));
  ramp = mix(ramp, cTop, smoothstep(0.45, 1.02, up));
  vec3 aur = aurora(qs, t);
  vec3 col = mix(ramp, aur, mix(0.30, 0.60, smoothstep(0.15, 1.0, up)) * (1.0 - uOff.z));

  // 斯涅尔窗：顶部中央的大柔光窗——全场唯一光源，带极慢水面闪烁与 ~8s 呼吸（大小/亮度 ±6%）
  // 光色与极光场联动：同一时刻的窗光与背景色相一致，不打架
  vec2 wv = (q - vec2(0.5 * aspect, 1.06)) * vec2(1.9, 1.35) / min(aspect, 1.0);
  wv /= 1.0 + 0.06 * sin(t * 0.785);
  float snell = exp(-dot(wv, wv) * 2.6);
  snell *= 0.9 + 0.1 * vnoise(vec2(q.x * 2.0, t * 0.02));
  snell *= 1.0 + 0.06 * sin(t * 0.785 + 1.3);
  col += mix(vec3(0.42, 0.60, 0.63), aur + vec3(0.22), 0.30) * snell * 0.6;

  // 光柱：2 条宽带自窗口落下，一柱青碧、一柱紫藤；高斯横向包络 + 内部纹理。
  // 竖屏修正：两柱间距按宽度算只有几十 pt，会合并成悬浮暗区的"光门"（静态鬼影）——
  // 竖屏时下半截提前收掉、强度减半，让光柱只存在于亮窗附近；桌面横屏行为不变。
  float portrait = smoothstep(0.9, 0.6, aspect); // 0 = 横屏/宽屏，1 = 竖屏手机
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    float x0 = 0.46 + fi * 0.10 + (fi - 0.5) * 0.06 * (1.0 - up);
    float sway = sin(t * 0.035 + fi * 2.4) * 0.045;
    float xr = x0 + sway * (1.0 - up);
    float wdt = 0.045 + 0.055 * (1.0 - up);
    float b = (quv.x - xr) / wdt;
    float beam = exp(-b * b);
    beam *= 0.6 + 0.4 * vnoise(vec2(quv.x * 9.0 + fi * 3.1, q.y * 2.5 - t * 0.04));
    float lowFade = mix(0.06, 0.42, portrait);
    float hiFade = mix(0.50, 0.68, portrait);
    beam *= smoothstep(lowFade, hiFade, up) * smoothstep(1.02, 0.7, up);
    beam *= 0.65 + 0.35 * vnoise(vec2(fi * 7.3, t * 0.028));
    vec3 rayTint = mix(vec3(0.50, 0.74, 0.80), vec3(0.68, 0.56, 0.88), fi);
    col += rayTint * beam * (1.0 - fi * 0.65) * mix(0.10, 0.055, portrait) * (1.0 - uOff.x);
  }

  // 焦散：domain-warped ridged fbm 细丝光网，限上半部；漂移 + 大尺度明暗流动，2-3s 可辨
  // 细丝带轻色散：随 warp 场在青白与淡紫间变化，像水面碎光的分色
  float driftA = t * 0.04;
  vec2 cp = qs * 6.0;
  vec2 warp = vec2(
    fbm(cp * 0.6 + vec2(driftA, -driftA * 0.7)),
    fbm(cp * 0.6 + vec2(5.2, 1.3) - driftA * 0.6));
  float cn = fbm(cp + (warp - 0.5) * 1.4 + vec2(driftA * 0.8, driftA * 0.5));
  float fil = 1.0 - abs(2.0 * cn - 1.0);
  fil = pow(fil, 9.0);
  float flow = 0.7 + 0.3 * fbm(qs * 1.3 + vec2(t * 0.05, -t * 0.036));
  vec3 causTint = mix(vec3(0.58, 0.80, 0.82), vec3(0.78, 0.64, 0.92), smoothstep(0.2, 0.8, warp.x));
  col += causTint * fil * flow * 0.12 * smoothstep(0.5, 0.95, up) * (1.0 - uOff.y);

  // 浮游微粒：三个深度层视差漂移，软圆盘无硬边；前景青碧 / 中层紫藤 / 深层蜜金
  for (int layer = 0; layer < 3; layer++) {
    float fl = float(layer);
    float gscale = 4.0 + fl * 4.5;
    vec2 gp = qs * gscale;
    vec2 id = floor(gp);
    vec2 f = fract(gp);
    float h1 = hash21(id + fl * 13.7);
    float h2 = hash21(id + 4.2 + fl * 7.9);
    if (h2 > 0.42) continue; // 稀疏化：半数以上格位留空
    vec2 pos = vec2(
      fract(h1 + sin(t * 0.05 + h2 * 6.2831) * 0.12 * (1.0 - fl * 0.35)),
      fract(h2 * 7.0 + t * (0.014 - 0.0036 * fl) * (0.5 + h1)));
    float rad = mix(0.16, 0.05, fl / 2.0);
    float mote = smoothstep(rad, fl < 0.5 ? 0.0 : rad * 0.4, length(f - pos));
    float twinkle = 0.5 + 0.5 * sin(t * (0.18 + h2 * 0.3) + h1 * 6.2831);
    vec3 moteTint = vec3(0.64, 0.80, 0.84);
    if (layer == 1) moteTint = vec3(0.76, 0.68, 0.94);
    if (layer == 2) moteTint = vec3(0.95, 0.85, 0.70);
    col += moteTint * mote * (0.35 + 0.65 * twinkle) * (0.050 - 0.004 * fl) * (1.0 - uOff.w);
  }
  return col;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y);

  // 涟漪：解析式衰减波，位移 + 微光
  vec2 disp = vec2(0.0);
  float glow = 0.0;
  for (int i = 0; i < 8; i++) {
    vec4 r = uRipples[i];
    if (r.w < 0.001) continue;
    float age = uTime - r.z;
    if (age < 0.0 || age > 6.0) continue;
    vec2 c = vec2(r.x * aspect, r.y);
    vec2 dv = p - c;
    float d = length(dv) + 0.0001;
    float radius = age * 0.22;
    float width = 0.035 + age * 0.028;
    float g = (d - radius) / width;
    float ring = exp(-g * g);
    float decay = exp(-age * 1.4) * r.w;
    float wave = sin((d - radius) * 42.0) * ring * decay;
    disp += (dv / d) * wave * 0.028;
    glow += ring * decay;
  }

  vec2 q = p + disp;
  vec3 col = background(q, aspect, uTime);
  // 涟漪微光：与极光场联动，触点荡开的不只是亮度还有一抹流动色
  vec3 aurG = aurora(q / min(aspect, 1.0), uTime);
  col += mix(vec3(0.50, 0.72, 0.76), aurG + vec3(0.15), 0.45) * glow * 0.12;

  // ─── 泡泡 ───
  float bAlpha = uBubbleMix.y;
  if (bAlpha > 0.001 && uBubbleRad.y > 0.0001) {
    float rec = uBubbleMix.x;
    float par = uBubbleMix.z;
    vec2 bd = (q - uBubblePos) / uBubbleRad; // 椭圆归一空间（浮动晃动时略椭）
    float rr = length(bd);
    if (rr < 1.6) { // 外晕范围之外直接跳过（屏幕 96% 像素走这里）
      float ang = atan(bd.y, bd.x);
      // 膜边界：三列错相慢正弦 ±4.4%——真实泡膜的呼吸起伏；录音态收拢成纯圆
      float wob = 1.0 + (0.020 * sin(ang * 3.0 + uTime * 0.9)
                       + 0.014 * sin(ang * 5.0 - uTime * 0.7 + 1.7)
                       + 0.010 * sin(ang * 8.0 + uTime * 1.3 + 4.1)) * (1.0 - rec);
      float sd = rr / wob;
      float aa = 2.0 / max(uBubbleRad.y * uRes.y, 1.0); // sd 单位 ≈2px 抗锯齿
      float inside = smoothstep(1.0 + aa, 1.0 - aa, sd);
      float sdc = min(sd, 1.0);
      float z = sqrt(max(0.0, 1.0 - sdc * sdc)); // 球面高度：1 在球心、0 在边缘

      // 薄膜干涉虹彩（余弦色盘）：膜厚随高度/横向缓变（重力下流 → 横向色带，
      // 物理上比角度项更真），随时间/浮动流转——不用 atan 角度项：atan2 在负 x 轴
      // 有 ±π 跳变，非整数系数会把跳变放大成泡泡正左方的水平断线
      float film = (1.0 - z) * 9.0 + bd.y * 2.2 + bd.x * 0.6 + uTime * 0.35 + par * 0.8;
      vec3 irid = 0.5 + 0.5 * cos(film * vec3(1.0, 1.07, 1.15) + vec3(0.0, 2.09, 4.19));
      irid = mix(vec3(dot(irid, vec3(0.333))), irid, 0.60);

      // 泡膜：折射重采样背景（RGB 三通道折射率微差 → 色散彩边）+ 菲涅尔虹彩边缘
      // + 主/副双柔高光（主光同场景光源方位：上方偏左）+ 底部聚光弧
      float rs = 0.09 * (1.0 - z * z) * (1.0 - rec);
      vec3 lens;
      lens.r = background(q + bd * rs * 0.78, aspect, uTime).r;
      lens.g = background(q + bd * rs * 1.00, aspect, uTime).g;
      lens.b = background(q + bd * rs * 1.22, aspect, uTime).b;
      float fres = pow(1.0 - z, 3.2);
      vec2 hp = bd - vec2(-0.36 + par * 0.04, 0.40);
      float spec = exp(-dot(hp, hp) * 10.0) * 0.55;
      vec2 hp2 = bd - vec2(0.42, -0.44);
      float spec2 = exp(-dot(hp2, hp2) * 16.0) * 0.14;
      float focus = exp(-pow(sd - 0.55, 2.0) * 18.0) * smoothstep(0.2, -0.6, bd.y) * 0.20;
      vec3 mem = lens * (0.94 + 0.10 * z)
        + irid * fres * 0.50
        + vec3(0.90, 0.96, 1.00) * spec
        + vec3(0.75, 0.85, 0.95) * spec2
        + vec3(0.85, 0.95, 1.00) * focus;

      // 录音红核：径向渐变 + 顶部水光，3s 极轻呼吸（与原 CSS rec-pulse 同频）
      float pulse = 0.85 + 0.15 * sin(uTime * 2.1);
      vec3 core = mix(vec3(0.91, 0.47, 0.44), vec3(0.62, 0.19, 0.21), smoothstep(0.1, 1.0, sd));
      core = (core + vec3(1.0, 0.62, 0.55) * pow(z, 2.5) * 0.30) * pulse;

      col = mix(col, mix(mem, core, rec), inside * bAlpha);

      // 外圈柔晕：膜态为淡虹彩呼吸晕，录音态为红晕
      float halo = exp(-max(sd - 1.0, 0.0) * 7.0);
      vec3 haloCol = mix(irid * 0.30, vec3(0.85, 0.30, 0.30) * pulse, rec);
      col += haloCol * halo * 0.18 * bAlpha;
    }
  }

  // 晕影：更柔更宽，只压四角
  float vig = smoothstep(1.5, 0.5, length(uv - vec2(0.5)));
  col *= mix(0.90, 1.0, vig);

  // 去色带：三角分布抖动（±1.8/255，常开）+ 桌面胶片颗粒——逐像素种子走整数位哈希
  // （lowbias32），与浮点精度无关；浮点哈希在 gl_FragCoord 大坐标下于部分移动 GPU
  // 退化成规则细格。触屏颗粒为 0（高 PPI 上 6fps 重播种呈雪花）
  uint px = uint(gl_FragCoord.x) * 1664525u + uint(gl_FragCoord.y) * 1013904223u;
  float d1 = float(uhash(px) & 0xFFFFFFu) / 16777216.0;
  float d2 = float(uhash(px ^ 0x9e3779b9u) & 0xFFFFFFu) / 16777216.0;
  col += (d1 + d2 - 1.0) * (1.8 / 255.0) * (1.0 - uOffDither);
  float grain = float(uhash(px ^ (uint(mod(uTime * 6.0, 1024.0)) + 1u) * 0x85ebca6bu) & 0xFFFFFFu) / 16777216.0 - 0.5;
  col *= 1.0 + grain * uGrain;

  fragColor = vec4(col, 1.0);
}`;

export interface WaterScene {
  readonly active: boolean;
  ripple(clientX: number, clientY: number, strength: number): void;
  setStatic(isStatic: boolean): void;
  // 每帧同步 DOM 录音键的屏幕几何与状态（client px；rec/alpha/par 无量纲 0..1）
  setBubble(cx: number, cy: number, rx: number, ry: number, rec: number, alpha: number, par: number): void;
}

const inactive: WaterScene = {
  active: false,
  ripple: () => undefined,
  setStatic: () => undefined,
  setBubble: () => undefined,
};

export function initWater(canvas: HTMLCanvasElement): WaterScene {
  let context: WebGL2RenderingContext | null = null;
  try {
    context = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
    });
  } catch {
    context = null;
  }
  if (!context) return inactive;
  const gl = context;

  const compile = (type: number, src: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return inactive;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return inactive;
  gl.useProgram(prog);

  const uRes = gl.getUniformLocation(prog, 'uRes');
  const uTime = gl.getUniformLocation(prog, 'uTime');
  const uRipples = gl.getUniformLocation(prog, 'uRipples[0]');
  const uGrain = gl.getUniformLocation(prog, 'uGrain');
  const uBubblePos = gl.getUniformLocation(prog, 'uBubblePos');
  const uBubbleRad = gl.getUniformLocation(prog, 'uBubbleRad');
  const uBubbleMix = gl.getUniformLocation(prog, 'uBubbleMix');
  const uOff = gl.getUniformLocation(prog, 'uOff');
  const uOffDither = gl.getUniformLocation(prog, 'uOffDither');
  if (!uRes || !uTime || !uRipples || !uGrain || !uBubblePos || !uBubbleRad || !uBubbleMix) return inactive;

  // pointer: coarse 比 UA 可靠（iPadOS 桌面模式 UA 谎称 Mac，但 pointer 仍为 coarse）
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  // DPR 统一封顶 2：触屏曾压到 1.5，但在 1260×2800 级屏幕上要放大 2.1 倍，
  // 焦散细丝被插值糊成云团；帧率不节流，跟随屏幕刷新率（60/120Hz）
  const maxDpr = 2;
  gl.uniform1f(uGrain, coarse ? 0 : 0.01);

  // 分层开关（远程诊断，不进文档）：?off=beams,caustics,aurora,motes,dither 任意组合
  if (uOff && uOffDither) {
    const off = new URLSearchParams(window.location.search).get('off') ?? '';
    gl.uniform4f(
      uOff,
      off.includes('beams') ? 1 : 0,
      off.includes('caustics') ? 1 : 0,
      off.includes('aurora') ? 1 : 0,
      off.includes('motes') ? 1 : 0,
    );
    gl.uniform1f(uOffDither, off.includes('dither') ? 1 : 0);
  }

  const ripples = new Float32Array(MAX_RIPPLES * 4);
  let slot = 0;
  const t0 = performance.now() / 1000;
  const now = (): number => performance.now() / 1000 - t0;

  // 泡泡状态（p 空间），由 RecordButton 的 rAF 每帧推入；static 模式下值变才补绘
  const bubble = { x: 0, y: 0, rx: 0, ry: 0, rec: 0, alpha: 0, par: 0 };

  let staticMode = prefersReducedMotion();
  let raf = 0;
  let resizeTimer = 0;

  const resize = (): void => {
    const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  };

  // 地址栏伸缩/旋转都会连发 resize：只取静默 150ms 后的最终尺寸，避免反复 realloc 闪变
  const scheduleResize = (): void => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resize();
      if (staticMode) draw(STATIC_TIME);
    }, 150);
  };

  const draw = (t: number): void => {
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, t);
    gl.uniform4fv(uRipples, ripples);
    gl.uniform2f(uBubblePos, bubble.x, bubble.y);
    gl.uniform2f(uBubbleRad, bubble.rx, bubble.ry);
    gl.uniform3f(uBubbleMix, bubble.rec, bubble.alpha, bubble.par);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const loop = (): void => {
    if (staticMode || document.hidden) return;
    draw(now());
    raf = requestAnimationFrame(loop);
  };

  window.addEventListener('resize', scheduleResize);
  window.visualViewport?.addEventListener('resize', scheduleResize);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      return;
    }
    if (staticMode) draw(STATIC_TIME);
    else {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    }
  });

  resize();
  if (staticMode) draw(STATIC_TIME);
  else raf = requestAnimationFrame(loop);

  return {
    active: true,
    ripple(clientX: number, clientY: number, strength: number): void {
      if (staticMode) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const i = slot * 4;
      slot = (slot + 1) % MAX_RIPPLES;
      ripples[i] = (clientX - rect.left) / rect.width;
      ripples[i + 1] = 1 - (clientY - rect.top) / rect.height;
      ripples[i + 2] = now();
      ripples[i + 3] = strength;
    },
    setStatic(isStatic: boolean): void {
      if (staticMode === isStatic) return;
      staticMode = isStatic;
      cancelAnimationFrame(raf);
      if (isStatic) draw(STATIC_TIME);
      else raf = requestAnimationFrame(loop);
    },
    setBubble(cx, cy, rx, ry, rec, alpha, par): void {
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (cw < 1 || ch < 1) return;
      // p 空间按画布高度归一：xy 半径同除 ch 即各向同性（aspect = cw/ch 恰好消去）
      const nx = (cx / cw) * (cw / ch);
      const ny = 1 - cy / ch;
      const nrx = rx / ch;
      const nry = ry / ch;
      const eps = 0.0004; // 亚像素级变化不重绘（仅 static 模式用得到）
      const changed =
        Math.abs(nx - bubble.x) > eps ||
        Math.abs(ny - bubble.y) > eps ||
        Math.abs(nrx - bubble.rx) > eps ||
        Math.abs(nry - bubble.ry) > eps ||
        Math.abs(rec - bubble.rec) > 0.002 ||
        Math.abs(alpha - bubble.alpha) > 0.002 ||
        Math.abs(par - bubble.par) > 0.002;
      bubble.x = nx;
      bubble.y = ny;
      bubble.rx = nrx;
      bubble.ry = nry;
      bubble.rec = rec;
      bubble.alpha = alpha;
      bubble.par = par;
      if (changed && staticMode) draw(STATIC_TIME);
    },
  };
}
