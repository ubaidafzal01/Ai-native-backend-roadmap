/*
 * Fluid "ink" cursor effect.
 * A small WebGL Navier–Stokes fluid simulation (advection → vorticity → pressure solve),
 * based on the technique popularised by Pavel Dobryakov's WebGL-Fluid-Simulation (MIT).
 * Moving the mouse / finger injects coloured dye that swirls and fades out.
 */
(() => {
  const canvas = document.getElementById('fluid');
  if (!canvas) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { canvas.remove(); return; }

  // Tweak these to change the feel
  const config = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1024,
    DENSITY_DISSIPATION: 0.9,   // higher = ink fades faster
    VELOCITY_DISSIPATION: 0.6,  // higher = motion stops sooner
    PRESSURE: 0.1,
    PRESSURE_ITERATIONS: 20,
    CURL: 6,                    // swirliness
    SPLAT_RADIUS: 0.25,
    SPLAT_FORCE: 6000,
    COLOR_UPDATE_SPEED: 10,
  };

  const context = getWebGLContext(canvas);
  if (!context) { canvas.remove(); return; }
  const { gl, ext } = context;

  function getWebGLContext(cv) {
    const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
    let g = cv.getContext('webgl2', params);
    const isWebGL2 = !!g;
    if (!isWebGL2) g = cv.getContext('webgl', params) || cv.getContext('experimental-webgl', params);
    if (!g) return null;

    let halfFloat, supportLinearFiltering;
    if (isWebGL2) {
      g.getExtension('EXT_color_buffer_float');
      supportLinearFiltering = g.getExtension('OES_texture_float_linear');
    } else {
      halfFloat = g.getExtension('OES_texture_half_float');
      supportLinearFiltering = g.getExtension('OES_texture_half_float_linear');
    }
    const halfFloatTexType = isWebGL2 ? g.HALF_FLOAT : halfFloat && halfFloat.HALF_FLOAT_OES;
    if (!halfFloatTexType) return null;
    g.clearColor(0, 0, 0, 0);

    let formatRGBA, formatRG, formatR;
    if (isWebGL2) {
      formatRGBA = getSupportedFormat(g, g.RGBA16F, g.RGBA, halfFloatTexType);
      formatRG = getSupportedFormat(g, g.RG16F, g.RG, halfFloatTexType);
      formatR = getSupportedFormat(g, g.R16F, g.RED, halfFloatTexType);
    } else {
      formatRGBA = formatRG = formatR = getSupportedFormat(g, g.RGBA, g.RGBA, halfFloatTexType);
    }
    if (!formatRGBA || !formatRG || !formatR) return null;
    return { gl: g, ext: { formatRGBA, formatRG, formatR, halfFloatTexType, supportLinearFiltering: !!supportLinearFiltering } };
  }

  function getSupportedFormat(g, internalFormat, format, type) {
    if (!supportRenderTextureFormat(g, internalFormat, format, type)) {
      if (internalFormat === g.R16F) return getSupportedFormat(g, g.RG16F, g.RG, type);
      if (internalFormat === g.RG16F) return getSupportedFormat(g, g.RGBA16F, g.RGBA, type);
      return null;
    }
    return { internalFormat, format };
  }

  function supportRenderTextureFormat(g, internalFormat, format, type) {
    const texture = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, texture);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    g.texImage2D(g.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    const fbo = g.createFramebuffer();
    g.bindFramebuffer(g.FRAMEBUFFER, fbo);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, texture, 0);
    const ok = g.checkFramebufferStatus(g.FRAMEBUFFER) === g.FRAMEBUFFER_COMPLETE;
    g.deleteFramebuffer(fbo);
    g.deleteTexture(texture);
    return ok;
  }

  // ---------- Shaders ----------
  const baseVertex = `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;

  const clearShader = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv;
    uniform sampler2D uTexture; uniform float value;
    void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`;

  // Dye is drawn as colour-with-alpha over the white page, which gives the pastel look
  const displayShader = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTexture;
    void main () {
      vec3 c = clamp(texture2D(uTexture, vUv).rgb, 0.0, 1.0);
      float a = max(c.r, max(c.g, c.b));
      gl_FragColor = vec4(c, a);
    }`;

  const splatShader = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color; uniform vec2 point; uniform float radius;
    void main () {
      vec2 p = vUv - point.xy;
      p.x *= aspectRatio;
      vec3 splat = exp(-dot(p, p) / radius) * color;
      vec3 base = texture2D(uTarget, vUv).xyz;
      gl_FragColor = vec4(base + splat, 1.0);
    }`;

  const advectionShader = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uVelocity; uniform sampler2D uSource;
    uniform vec2 texelSize; uniform vec2 dyeTexelSize;
    uniform float dt; uniform float dissipation;
    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
      vec2 st = uv / tsize - 0.5;
      vec2 iuv = floor(st);
      vec2 fuv = fract(st);
      vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
      vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
      vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
      vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
      return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }
    void main () {
    #ifdef MANUAL_FILTERING
      vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
      vec4 result = bilerp(uSource, coord, dyeTexelSize);
    #else
      vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
      vec4 result = texture2D(uSource, coord);
    #endif
      float decay = 1.0 + dissipation * dt;
      gl_FragColor = result / decay;
    }`;

  const divergenceShader = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).x;
      float R = texture2D(uVelocity, vR).x;
      float T = texture2D(uVelocity, vT).y;
      float B = texture2D(uVelocity, vB).y;
      vec2 C = texture2D(uVelocity, vUv).xy;
      if (vL.x < 0.0) { L = -C.x; }
      if (vR.x > 1.0) { R = -C.x; }
      if (vT.y > 1.0) { T = -C.y; }
      if (vB.y < 0.0) { B = -C.y; }
      float div = 0.5 * (R - L + T - B);
      gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }`;

  const curlShader = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).y;
      float R = texture2D(uVelocity, vR).y;
      float T = texture2D(uVelocity, vT).x;
      float B = texture2D(uVelocity, vB).x;
      float vorticity = R - L - T + B;
      gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
    }`;

  const vorticityShader = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
    uniform sampler2D uVelocity; uniform sampler2D uCurl;
    uniform float curl; uniform float dt;
    void main () {
      float L = texture2D(uCurl, vL).x;
      float R = texture2D(uCurl, vR).x;
      float T = texture2D(uCurl, vT).x;
      float B = texture2D(uCurl, vB).x;
      float C = texture2D(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001;
      force *= curl * C;
      force.y *= -1.0;
      vec2 velocity = texture2D(uVelocity, vUv).xy;
      velocity += force * dt;
      velocity = min(max(velocity, -1000.0), 1000.0);
      gl_FragColor = vec4(velocity, 0.0, 1.0);
    }`;

  const pressureShader = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uPressure; uniform sampler2D uDivergence;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      float divergence = texture2D(uDivergence, vUv).x;
      float pressure = (L + R + B + T - divergence) * 0.25;
      gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }`;

  const gradientSubtractShader = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uPressure; uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      vec2 velocity = texture2D(uVelocity, vUv).xy;
      velocity.xy -= vec2(R - L, T - B);
      gl_FragColor = vec4(velocity, 0.0, 1.0);
    }`;

  function compileShader(type, source, keywords) {
    if (keywords) source = keywords.map((k) => `#define ${k}\n`).join('') + source;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  const vertexShader = compileShader(gl.VERTEX_SHADER, baseVertex);

  function createProgram(fragmentSource, keywords) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentSource, keywords));
    gl.bindAttribLocation(program, 0, 'aPosition');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(program, i).name;
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { uniforms, bind: () => gl.useProgram(program) };
  }

  let programs;
  try {
    programs = {
      clear: createProgram(clearShader),
      display: createProgram(displayShader),
      splat: createProgram(splatShader),
      advection: createProgram(advectionShader, ext.supportLinearFiltering ? null : ['MANUAL_FILTERING']),
      divergence: createProgram(divergenceShader),
      curl: createProgram(curlShader),
      vorticity: createProgram(vorticityShader),
      pressure: createProgram(pressureShader),
      gradientSubtract: createProgram(gradientSubtractShader),
    };
  } catch (e) {
    console.warn('Fluid effect disabled:', e);
    canvas.remove();
    return;
  }

  // Full-screen quad
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  function blit(target) {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  // ---------- Framebuffers ----------
  function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture, fbo, width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
      attach(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; },
      dispose() { gl.deleteTexture(texture); gl.deleteFramebuffer(fbo); },
    };
  }

  function createDoubleFBO(w, h, internalFormat, format, type, param) {
    let a = createFBO(w, h, internalFormat, format, type, param);
    let b = createFBO(w, h, internalFormat, format, type, param);
    return {
      width: w, height: h, texelSizeX: a.texelSizeX, texelSizeY: a.texelSizeY,
      get read() { return a; },
      get write() { return b; },
      swap() { const t = a; a = b; b = t; },
      dispose() { a.dispose(); b.dispose(); },
    };
  }

  function getResolution(resolution) {
    let aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1 / aspect;
    const min = Math.round(resolution);
    const max = Math.round(resolution * aspect);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? { width: max, height: min } : { width: min, height: max };
  }

  let dye, velocity, divergence, curl, pressure;
  function initFramebuffers() {
    [dye, velocity, divergence, curl, pressure].forEach((f) => f && f.dispose());
    const simRes = getResolution(config.SIM_RESOLUTION);
    const dyeRes = getResolution(config.DYE_RESOLUTION);
    const type = ext.halfFloatTexType;
    const { formatRGBA: rgba, formatRG: rg, formatR: r } = ext;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    gl.disable(gl.BLEND);
    dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, type, filtering);
    velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, type, filtering);
    divergence = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, type, gl.NEAREST);
    curl = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, type, gl.NEAREST);
    pressure = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, type, gl.NEAREST);
  }

  // ---------- Simulation ----------
  function step(dt) {
    gl.disable(gl.BLEND);
    const tx = velocity.texelSizeX, ty = velocity.texelSizeY;

    let p = programs.curl; p.bind();
    gl.uniform2f(p.uniforms.texelSize, tx, ty);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    p = programs.vorticity; p.bind();
    gl.uniform2f(p.uniforms.texelSize, tx, ty);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(p.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(p.uniforms.curl, config.CURL);
    gl.uniform1f(p.uniforms.dt, dt);
    blit(velocity.write); velocity.swap();

    p = programs.divergence; p.bind();
    gl.uniform2f(p.uniforms.texelSize, tx, ty);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    p = programs.clear; p.bind();
    gl.uniform1i(p.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(p.uniforms.value, config.PRESSURE);
    blit(pressure.write); pressure.swap();

    p = programs.pressure; p.bind();
    gl.uniform2f(p.uniforms.texelSize, tx, ty);
    gl.uniform1i(p.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(p.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    p = programs.gradientSubtract; p.bind();
    gl.uniform2f(p.uniforms.texelSize, tx, ty);
    gl.uniform1i(p.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();

    p = programs.advection; p.bind();
    gl.uniform2f(p.uniforms.texelSize, tx, ty);
    if (p.uniforms.dyeTexelSize) gl.uniform2f(p.uniforms.dyeTexelSize, tx, ty);
    const velocityId = velocity.read.attach(0);
    gl.uniform1i(p.uniforms.uVelocity, velocityId);
    gl.uniform1i(p.uniforms.uSource, velocityId);
    gl.uniform1f(p.uniforms.dt, dt);
    gl.uniform1f(p.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write); velocity.swap();

    if (p.uniforms.dyeTexelSize) gl.uniform2f(p.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(p.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(p.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write); dye.swap();
  }

  function render() {
    gl.disable(gl.BLEND);
    const p = programs.display; p.bind();
    gl.uniform1i(p.uniforms.uTexture, dye.read.attach(0));
    blit(null);
  }

  function splat(x, y, dx, dy, color) {
    const p = programs.splat; p.bind();
    gl.uniform1i(p.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(p.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(p.uniforms.point, x, y);
    gl.uniform3f(p.uniforms.color, dx, dy, 0);
    gl.uniform1f(p.uniforms.radius, correctRadius(config.SPLAT_RADIUS / 100));
    blit(velocity.write); velocity.swap();

    gl.uniform1i(p.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(p.uniforms.color, color.r, color.g, color.b);
    blit(dye.write); dye.swap();
  }

  function correctRadius(radius) {
    const aspect = canvas.width / canvas.height;
    return aspect > 1 ? radius * aspect : radius;
  }

  // ---------- Colours ----------
  function generateColor() {
    const c = HSVtoRGB(Math.random(), 1, 1);
    c.r *= 0.2; c.g *= 0.2; c.b *= 0.2;
    return c;
  }

  function HSVtoRGB(h, s, v) {
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return { r, g, b };
  }

  // ---------- Input ----------
  const pointer = { x: 0, y: 0, prevX: 0, prevY: 0, dx: 0, dy: 0, moved: false, started: false, color: generateColor() };
  const ratio = () => window.devicePixelRatio || 1;

  function updatePointer(clientX, clientY) {
    const x = (clientX * ratio()) / canvas.width;
    const y = 1 - (clientY * ratio()) / canvas.height;
    if (!pointer.started) { pointer.x = x; pointer.y = y; pointer.started = true; }
    pointer.prevX = pointer.x; pointer.prevY = pointer.y;
    pointer.x = x; pointer.y = y;
    const aspect = canvas.width / canvas.height;
    pointer.dx = (x - pointer.prevX) * (aspect < 1 ? aspect : 1);
    pointer.dy = (y - pointer.prevY) / (aspect > 1 ? aspect : 1);
    pointer.moved = Math.abs(pointer.dx) > 0 || Math.abs(pointer.dy) > 0;
  }

  function clickSplat(clientX, clientY) {
    const x = (clientX * ratio()) / canvas.width;
    const y = 1 - (clientY * ratio()) / canvas.height;
    const c = generateColor();
    c.r *= 10; c.g *= 10; c.b *= 10;
    splat(x, y, 10 * (Math.random() - 0.5), 30 * (Math.random() - 0.5), c);
  }

  window.addEventListener('mousemove', (e) => updatePointer(e.clientX, e.clientY));
  window.addEventListener('mousedown', (e) => clickSplat(e.clientX, e.clientY));
  window.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    pointer.started = false;
    updatePointer(t.clientX, t.clientY);
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    updatePointer(t.clientX, t.clientY);
  }, { passive: true });

  // ---------- Loop ----------
  function resizeCanvas() {
    const w = Math.floor(canvas.clientWidth * ratio());
    const h = Math.floor(canvas.clientHeight * ratio());
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      return true;
    }
    return false;
  }

  resizeCanvas();
  initFramebuffers();

  let lastTime = performance.now();
  let colorTimer = 0;
  function frame() {
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.016666);
    lastTime = now;

    if (resizeCanvas()) initFramebuffers();

    colorTimer += dt * config.COLOR_UPDATE_SPEED;
    if (colorTimer >= 1) { colorTimer %= 1; pointer.color = generateColor(); }

    if (pointer.moved) {
      pointer.moved = false;
      splat(pointer.x, pointer.y, pointer.dx * config.SPLAT_FORCE, pointer.dy * config.SPLAT_FORCE, pointer.color);
    }

    step(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
