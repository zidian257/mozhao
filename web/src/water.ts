import { prefersReducedMotion } from './reduced-motion';

// 环境水景：raw WebGL2 全屏三角形，单 pass fragment shader。
// pass 内分层（自底向上）：双色深度 ramp → 斯涅尔窗口光 → 细丝焦散 → 窄光柱 → 景深微粒
// → 涟漪位移与微光 → 柔晕影 → 去色带抖动 + 胶片颗粒。
// uniform 接口：
//   uRes(vec2)      画布物理像素尺寸
//   uTime(float)    秒
//   uRipples[8](vec4) x=uv.x, y=uv.y, z=起始时刻(秒), w=强度（0 为空闲槽）
//   uGrain(float)   胶片颗粒幅度（桌面 0.010；触屏 0——高 PPI OLED 上 6fps 重播种呈雪花闪烁）
// 涟漪为解析式衰减波叠加：环形高斯包络外扩 + 正弦相位 → 采样位移（扭曲焦散/光柱）+ 微光。
// 构图：p 空间按画布高度归一（x = uv.x*aspect），圆形距离各向同性，任意宽高比不变形；
// 斯涅尔窗/光柱/焦散均锚定顶中，竖屏天然成立。
// 图案尺度（焦散/微粒）锚定短边 ps = p / min(aspect,1)：竖屏手机上若按屏高归一，
// 细丝光网会被放大成满屏云团——按短边归一后，任何设备上图案密度一致。
// 移动端保护（pointer: coarse）：颗粒归零（dither 保留防色带）。全平台 60fps、DPR 封顶 2。
// resize：地址栏伸缩会高频触发，只做 150ms 防抖后的 buffer 重设——过渡期旧 buffer 被 CSS
// 软拉伸，无重 alloc 跳变。监听 window resize + visualViewport.resize。
// 降级：WebGL2 不可用 / 编译失败 → 返回 inactive（调用方回退 CSS 渐变）；
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

uniform vec2 uRes;
uniform float uTime;
uniform vec4 uRipples[8];
uniform float uGrain;

out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
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
  vec2 quv = vec2(q.x / aspect, q.y);
  float up = clamp(quv.y, 0.0, 1.0);
  // 短边归一图案坐标：ps = p / min(aspect, 1)，竖屏与桌面图案密度一致
  vec2 qs = q / min(aspect, 1.0);

  // 双色 ramp：顶部青碧（略偏绿）→ 中部灰蓝 → 底部深靛蓝（一丝紫），无纯黑无高饱和
  vec3 cTop = vec3(0.220, 0.380, 0.400);
  vec3 cMid = vec3(0.190, 0.260, 0.330);
  vec3 cBot = vec3(0.115, 0.140, 0.205);
  vec3 col = mix(cBot, cMid, smoothstep(0.0, 0.55, up));
  col = mix(col, cTop, smoothstep(0.45, 1.02, up));

  // 斯涅尔窗：顶部中央的大柔光窗——全场唯一光源，带极慢水面闪烁与 ~8s 呼吸（大小/亮度 ±6%）
  // 尺寸走短边归一：竖屏上窗口按宽度收敛，亮区只占顶部一小条，不会照亮半个屏幕
  vec2 wv = (q - vec2(0.5 * aspect, 1.06)) * vec2(1.9, 1.35) / min(aspect, 1.0);
  wv /= 1.0 + 0.06 * sin(uTime * 0.785);
  float snell = exp(-dot(wv, wv) * 2.6);
  snell *= 0.9 + 0.1 * vnoise(vec2(q.x * 2.0, uTime * 0.02));
  snell *= 1.0 + 0.06 * sin(uTime * 0.785 + 1.3);
  col += vec3(0.36, 0.56, 0.60) * snell * 0.6;

  // 光柱：2 条宽带自窗口落下，高斯横向包络 + 内部纹理，向下半场消散；第二条几乎不可见。
  // 竖屏修正：两柱间距按宽度算只有几十 pt，会合并成一根悬浮暗区的"光门"（静态鬼影）——
  // 竖屏时下半截提前收掉、强度减半，让光柱只存在于亮窗附近；桌面横屏行为不变。
  float portrait = smoothstep(0.9, 0.6, aspect); // 0 = 横屏/宽屏，1 = 竖屏手机
  float rays = 0.0;
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    float x0 = 0.46 + fi * 0.10 + (fi - 0.5) * 0.06 * (1.0 - up);
    float sway = sin(uTime * 0.035 + fi * 2.4) * 0.045;
    float xr = x0 + sway * (1.0 - up);
    float wdt = 0.045 + 0.055 * (1.0 - up);
    float b = (quv.x - xr) / wdt;
    float beam = exp(-b * b);
    beam *= 0.6 + 0.4 * vnoise(vec2(quv.x * 9.0 + fi * 3.1, q.y * 2.5 - uTime * 0.04));
    float lowFade = mix(0.06, 0.42, portrait);
    float hiFade = mix(0.50, 0.68, portrait);
    beam *= smoothstep(lowFade, hiFade, up) * smoothstep(1.02, 0.7, up);
    beam *= 0.65 + 0.35 * vnoise(vec2(fi * 7.3, uTime * 0.028));
    rays += beam * (1.0 - fi * 0.65);
  }
  col += vec3(0.50, 0.72, 0.76) * rays * mix(0.10, 0.055, portrait);

  // 焦散：domain-warped ridged fbm 细丝光网，限上半部；漂移 + 大尺度明暗流动，2-3s 可辨
  // 尺度走 qs（短边归一）：竖屏上仍是细丝，不会糊成大云团
  float driftA = uTime * 0.04;
  vec2 cp = qs * 6.0;
  vec2 warp = vec2(
    fbm(cp * 0.6 + vec2(driftA, -driftA * 0.7)),
    fbm(cp * 0.6 + vec2(5.2, 1.3) - driftA * 0.6));
  float cn = fbm(cp + (warp - 0.5) * 1.4 + vec2(driftA * 0.8, driftA * 0.5));
  float fil = 1.0 - abs(2.0 * cn - 1.0);
  fil = pow(fil, 9.0);
  float flow = 0.7 + 0.3 * fbm(qs * 1.3 + vec2(uTime * 0.05, -uTime * 0.036));
  col += vec3(0.55, 0.75, 0.78) * fil * flow * 0.12 * smoothstep(0.5, 0.95, up);

  // 浮游微粒：三个深度层视差漂移，软圆盘无硬边；前景大而暗（bokeh 失焦）并缓慢横移
  // 网格尺度同样走 qs——竖屏上 bokeh 光斑保持与桌面一致的相对大小
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
      fract(h1 + sin(uTime * 0.05 + h2 * 6.2831) * 0.12 * (1.0 - fl * 0.35)),
      fract(h2 * 7.0 + uTime * (0.014 - 0.0036 * fl) * (0.5 + h1)));
    float rad = mix(0.16, 0.05, fl / 2.0);
    float mote = smoothstep(rad, fl < 0.5 ? 0.0 : rad * 0.4, length(f - pos));
    float twinkle = 0.5 + 0.5 * sin(uTime * (0.18 + h2 * 0.3) + h1 * 6.2831);
    col += vec3(0.60, 0.76, 0.80) * mote * (0.35 + 0.65 * twinkle) * (0.050 - 0.004 * fl);
  }

  col += vec3(0.50, 0.72, 0.76) * glow * 0.12;

  // 晕影：更柔更宽，只压四角
  float vig = smoothstep(1.5, 0.5, length(uv - vec2(0.5)));
  col *= mix(0.90, 1.0, vig);

  // 去色带：三角分布抖动（±1.8/255，常开）——OLED 暗部渐变的 8bit 色带会被慢动画
  // 带着爬动，比线性抖动多压一档；触屏胶片颗粒为 0（高 PPI 上 6fps 重播种呈雪花）
  float d1 = hash21(gl_FragCoord.xy);
  float d2 = hash21(gl_FragCoord.xy + vec2(127.1, 311.7));
  col += (d1 + d2 - 1.0) * (1.8 / 255.0);
  float gt = floor(uTime * 6.0);
  float grain = hash21(gl_FragCoord.xy + vec2(mod(gt, 16.0) * 17.0, mod(gt, 9.0) * 29.0)) - 0.5;
  col *= 1.0 + grain * uGrain;

  fragColor = vec4(col, 1.0);
}`;

export interface WaterScene {
  readonly active: boolean;
  ripple(clientX: number, clientY: number, strength: number): void;
  setStatic(isStatic: boolean): void;
}

const inactive: WaterScene = {
  active: false,
  ripple: () => undefined,
  setStatic: () => undefined,
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
  if (!uRes || !uTime || !uRipples || !uGrain) return inactive;

  // pointer: coarse 比 UA 可靠（iPadOS 桌面模式 UA 谎称 Mac，但 pointer 仍为 coarse）
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  // DPR 统一封顶 2：触屏曾压到 1.5，但在 1260×2800 级屏幕上要放大 2.1 倍，
  // 焦散细丝被插值糊成云团；帧率不节流，跟随屏幕刷新率（60/120Hz）
  const maxDpr = 2;
  gl.uniform1f(uGrain, coarse ? 0 : 0.01);

  const ripples = new Float32Array(MAX_RIPPLES * 4);
  let slot = 0;
  const t0 = performance.now() / 1000;
  const now = (): number => performance.now() / 1000 - t0;

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
  };
}
