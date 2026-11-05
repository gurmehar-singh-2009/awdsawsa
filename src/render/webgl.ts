import { BOX_STRIDE, type Frame, type MeshDraw, type Renderer } from './scene'
import { MESHES } from './meshes'

/*
 * GPU renderer. Works on WebGL2 or WebGL1 + ANGLE_instanced_arrays (GLSL 100 everywhere).
 * Draw calls per frame: sky (1) + bricks (1) + dynamic boxes (1-2) + one per mesh.
 * Studs, brick outlines and rock texture are computed procedurally in the fragment shader:
 * no textures are loaded at all.
 */

const COMMON = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec3 u_cam;
uniform vec3 u_sun;
uniform vec3 u_sunCol;
uniform vec3 u_skyTop;
uniform vec3 u_skyHor;
uniform vec3 u_ground;
uniform vec2 u_fog;
vec3 light(vec3 n, vec3 col) {
  float d = max(dot(n, u_sun), 0.0);
  vec3 amb = mix(u_ground, u_skyHor, n.y * 0.5 + 0.5) * 0.62;
  return col * (amb + u_sunCol * d * 0.78);
}
vec3 fog(vec3 c, vec3 wp) {
  float f = clamp((distance(wp, u_cam) - u_fog.x) / (u_fog.y - u_fog.x), 0.0, 1.0);
  return mix(c, u_skyHor, f * f);
}
`

const BOX_VS = `
attribute vec3 a_v;
attribute vec3 a_n;
attribute vec3 i_pos;
attribute vec4 i_q;
attribute vec3 i_size;
attribute vec3 i_col;
attribute vec3 i_mas; // material, alpha, seed
uniform mat4 u_vp;
varying vec3 v_n;
varying vec3 v_col;
varying vec3 v_local;
varying vec3 v_ln;
varying vec3 v_size;
varying vec3 v_wp;
varying vec3 v_mas;
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  vec3 lp = a_v * i_size;
  vec3 wp = i_pos + qrot(i_q, lp);
  v_n = qrot(i_q, a_n);
  v_col = i_col;
  v_local = lp;
  v_ln = a_n;
  v_size = i_size;
  v_wp = wp;
  v_mas = i_mas;
  gl_Position = u_vp * vec4(wp, 1.0);
}`

const BOX_FS = `
varying vec3 v_n;
varying vec3 v_col;
varying vec3 v_local;
varying vec3 v_ln;
varying vec3 v_size;
varying vec3 v_wp;
varying vec3 v_mas;
uniform float u_time;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 col = v_col;
  float mat = v_mas.x;
  vec3 n = normalize(v_n);
  // face-local 2D coordinates and size, so outlines and studs work on any face
  vec2 uv; vec2 fs;
  if (abs(v_ln.y) > 0.5) { uv = v_local.xz; fs = v_size.xz; }
  else if (abs(v_ln.x) > 0.5) { uv = v_local.zy; fs = v_size.zy; }
  else { uv = v_local.xy; fs = v_size.xy; }
  if (mat > 1.5 && mat < 2.5) {
    // glow: emissive with a slow pulse
    float p = 0.85 + 0.15 * sin(u_time * 3.0 + v_mas.z);
    gl_FragColor = vec4(fog(col * 1.25 * p + 0.15, v_wp), v_mas.y);
    return;
  }
  if (mat > 2.5 && mat < 3.5) {
    // island rock: grassy top, layered stone sides with blocky noise
    vec3 cell = floor(v_wp * vec3(0.5, 0.7, 0.5));
    float h = hash(cell);
    if (v_ln.y > 0.5) col = mix(vec3(0.30, 0.56, 0.22), vec3(0.36, 0.63, 0.25), h);
    else col = mix(col * 0.85, col * 1.08, h) * (0.8 + 0.2 * clamp((v_wp.y + 30.0) / 30.0, 0.0, 1.0));
    gl_FragColor = vec4(fog(light(n, col), v_wp), 1.0);
    return;
  }
  vec2 e = fs * 0.5 - abs(uv);
  float edge = min(e.x, e.y);
  if (mat < 3.5) col *= 0.94 + 0.06 * fract(v_mas.z * 0.6180339);
  if (mat > 0.5 && mat < 1.5 && v_ln.y > 0.5) {
    // studs: one per square stud on the top face, lit as a raised ring
    vec2 g = fract(uv + fs * 0.5) - 0.5;
    float r = length(g);
    if (r < 0.3) {
      float rim = smoothstep(0.22, 0.3, r);
      col *= 1.0 + 0.12 * (1.0 - rim) - 0.18 * rim * max(0.0, g.x + g.y) * 2.0;
    }
  }
  vec3 c = light(n, col);
  if (mat < 3.5) c *= mix(0.68, 1.0, smoothstep(0.0, 0.07, edge));
  gl_FragColor = vec4(fog(c, v_wp), v_mas.y);
}`

const MESH_VS = `
attribute vec3 a_v;
attribute vec3 a_n;
attribute vec4 a_c;
uniform mat4 u_vp;
uniform mat4 u_m;
uniform vec4 u_tint;
varying vec3 v_n;
varying vec4 v_c;
varying vec3 v_wp;
void main() {
  vec4 wp = u_m * vec4(a_v, 1.0);
  v_wp = wp.xyz;
  v_n = (u_m * vec4(a_n, 0.0)).xyz;
  vec3 c = a_c.rgb;
  float white = step(0.85, min(c.r, min(c.g, c.b)));
  v_c = vec4(mix(c, c * u_tint.rgb, white * u_tint.a), a_c.a);
  gl_Position = u_vp * wp;
}`

const MESH_FS = `
varying vec3 v_n;
varying vec4 v_c;
varying vec3 v_wp;
uniform float u_alpha;
void main() {
  vec3 c = v_c.a > 0.5 ? v_c.rgb * 1.3 + 0.1 : light(normalize(v_n), v_c.rgb);
  gl_FragColor = vec4(fog(c, v_wp), u_alpha);
}`

const SKY_VS = `
attribute vec2 a_p;
varying vec2 v_p;
void main() { v_p = a_p; gl_Position = vec4(a_p, 0.9999, 1.0); }`

const SKY_FS = `
varying vec2 v_p;
uniform vec3 u_fwd;
uniform vec3 u_right;
uniform vec3 u_up;
uniform vec2 u_tan;
void main() {
  vec3 d = normalize(u_fwd + u_right * v_p.x * u_tan.x + u_up * v_p.y * u_tan.y);
  float h = clamp(d.y, -1.0, 1.0);
  vec3 c = mix(u_skyHor, u_skyTop, smoothstep(0.0, 0.55, h));
  c = mix(c, u_skyHor * 0.82, smoothstep(0.0, -0.4, h));
  float s = max(dot(d, u_sun), 0.0);
  c += u_sunCol * (pow(s, 600.0) * 1.5 + pow(s, 12.0) * 0.12);
  gl_FragColor = vec4(c, 1.0);
}`

// unit cube: 36 vertices, position + normal
function cubeVerts() {
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, -1]], [[-1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[0, 1, 0], [0, 0, -1], [1, 0, 0]], [[0, -1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, 0, 1], [0, 1, 0], [1, 0, 0]], [[0, 0, -1], [0, 1, 0], [-1, 0, 0]],
  ]
  const out: number[] = []
  for (const [n, u, v] of faces) {
    const c = (a: number, b: number) => [
      n[0] * 0.5 + u[0] * a + v[0] * b, n[1] * 0.5 + u[1] * a + v[1] * b, n[2] * 0.5 + u[2] * a + v[2] * b,
    ]
    const q = [c(-0.5, -0.5), c(-0.5, 0.5), c(0.5, 0.5), c(0.5, -0.5)]
    // ensure CCW when seen from outside
    const cr = cross(sub(q[1], q[0]), sub(q[2], q[0]))
    const order = dot(cr, n) > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]
    for (const i of order) out.push(...q[i], ...n)
  }
  return new Float32Array(out)
  function sub(a: number[], b: number[]) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
  function cross(a: number[], b: number[]) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
  function dot(a: number[], b: number[]) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
}

type GL = WebGLRenderingContext | WebGL2RenderingContext

interface Prog { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null>; a: Record<string, number> }

export class WebGLRenderer implements Renderer {
  readonly kind = 'webgl'
  label = 'WebGL'
  private gl: GL
  private inst: { divisor(i: number, d: number): void; drawInstanced(n: number, count: number): void }
  private box: Prog
  private mesh: Prog
  private sky: Prog
  private cube: WebGLBuffer
  private skyBuf: WebGLBuffer
  private brickBuf: WebGLBuffer
  private brickCap = 0
  private dynBuf: WebGLBuffer
  private dynCap = 0
  private meshBufs = new Map<string, { buf: WebGLBuffer; n: number }>()
  private tint = new Float32Array(4)

  static create(canvas: HTMLCanvasElement, antialias: boolean): WebGLRenderer | null {
    const opts: WebGLContextAttributes = {
      antialias, alpha: false, depth: true, stencil: false, powerPreference: 'default',
      preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: true,
    }
    let gl: GL | null = canvas.getContext('webgl2', opts) as WebGL2RenderingContext | null
    if (!gl) gl = canvas.getContext('webgl', opts) as WebGLRenderingContext | null
    if (!gl) return null
    try {
      return new WebGLRenderer(gl)
    } catch (e) {
      console.warn('WebGL init failed', e)
      return null
    }
  }

  private constructor(gl: GL) {
    this.gl = gl
    const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
    if (isGL2) {
      const g = gl as WebGL2RenderingContext
      this.inst = {
        divisor: (i, d) => g.vertexAttribDivisor(i, d),
        drawInstanced: (n, c) => g.drawArraysInstanced(g.TRIANGLES, 0, n, c),
      }
      this.label = 'WebGL 2'
    } else {
      const ext = gl.getExtension('ANGLE_instanced_arrays')
      if (!ext) throw new Error('no instancing')
      this.inst = {
        divisor: (i, d) => ext.vertexAttribDivisorANGLE(i, d),
        drawInstanced: (n, c) => ext.drawArraysInstancedANGLE(gl.TRIANGLES, 0, n, c),
      }
      this.label = 'WebGL 1'
    }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    if (dbg) this.label += ' · ' + String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).slice(0, 40)

    this.box = this.program(BOX_VS, COMMON + BOX_FS)
    this.mesh = this.program(MESH_VS, COMMON + MESH_FS)
    this.sky = this.program(SKY_VS, COMMON + SKY_FS)
    this.cube = this.buffer(cubeVerts(), gl.STATIC_DRAW)
    this.skyBuf = this.buffer(new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    this.brickBuf = gl.createBuffer()!
    this.dynBuf = gl.createBuffer()!
    for (const [name, m] of Object.entries(MESHES)) {
      this.meshBufs.set(name, { buf: this.buffer(m.verts, gl.STATIC_DRAW), n: m.triCount * 3 })
    }
    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.CULL_FACE)
    gl.clearColor(0.7, 0.83, 0.95, 1)
  }

  private buffer(data: Float32Array, usage: number) {
    const gl = this.gl, b = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, b)
    gl.bufferData(gl.ARRAY_BUFFER, data, usage)
    return b
  }

  private program(vs: string, fs: string): Prog {
    const gl = this.gl
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader')
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, sh(gl.VERTEX_SHADER, COMMON.split('uniform')[0] + vs))
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link')
    const u: Prog['u'] = {}, a: Prog['a'] = {}
    const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
    for (let i = 0; i < nu; i++) {
      const info = gl.getActiveUniform(p, i)!
      u[info.name] = gl.getUniformLocation(p, info.name)
    }
    const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES)
    for (let i = 0; i < na; i++) {
      const info = gl.getActiveAttrib(p, i)!
      a[info.name] = gl.getAttribLocation(p, info.name)
    }
    return { p, u, a }
  }

  resize(w: number, h: number, scale: number) {
    const c = this.gl.canvas as HTMLCanvasElement
    const pw = Math.max(1, Math.round(w * scale)), ph = Math.max(1, Math.round(h * scale))
    if (c.width !== pw || c.height !== ph) {
      c.width = pw
      c.height = ph
    }
    this.gl.viewport(0, 0, pw, ph)
  }

  private env(p: Prog, f: Frame) {
    const gl = this.gl, e = f.env, u = p.u
    gl.uniform3f(u.u_cam, f.cam.pos.x, f.cam.pos.y, f.cam.pos.z)
    gl.uniform3fv(u.u_sun, e.sunDir)
    gl.uniform3fv(u.u_sunCol, e.sunColor)
    gl.uniform3fv(u.u_skyTop, e.skyTop)
    gl.uniform3fv(u.u_skyHor, e.skyHorizon)
    if (u.u_ground) gl.uniform3fv(u.u_ground, e.ground)
    if (u.u_fog) gl.uniform2f(u.u_fog, e.fogNear, e.fogFar)
    if (u.u_vp) gl.uniformMatrix4fv(u.u_vp, false, f.cam.viewProj)
  }

  render(f: Frame) {
    const gl = this.gl
    gl.clear(gl.DEPTH_BUFFER_BIT)

    // --- sky
    gl.useProgram(this.sky.p)
    this.env(this.sky, f)
    const c = f.cam, t = Math.tan(c.fov / 2)
    gl.uniform3f(this.sky.u.u_fwd, c.fwd.x, c.fwd.y, c.fwd.z)
    gl.uniform3f(this.sky.u.u_right, c.right.x, c.right.y, c.right.z)
    gl.uniform3f(this.sky.u.u_up, c.up.x, c.up.y, c.up.z)
    gl.uniform2f(this.sky.u.u_tan, t * c.aspect, t)
    gl.depthMask(false)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf)
    const ap = this.sky.a.a_p
    gl.enableVertexAttribArray(ap)
    gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.disableVertexAttribArray(ap)
    gl.depthMask(true)

    // --- boxes
    gl.useProgram(this.box.p)
    this.env(this.box, f)
    gl.uniform1f(this.box.u.u_time, f.time)
    this.bindCube()
    this.uploadBricks(f)
    this.drawBoxes(this.brickBuf, f.brickCount)
    if (f.dyn.count) {
      this.uploadDyn(f.dyn.data, f.dyn.count)
      this.drawBoxes(this.dynBuf, f.dyn.count)
    }
    this.unbindInstanced()

    // --- meshes
    gl.useProgram(this.mesh.p)
    this.env(this.mesh, f)
    for (const d of f.meshes) this.drawMesh(d)
    this.disableMesh()

    // --- translucent pass
    if (f.dynAlpha.count || f.alphaMeshes.length) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      gl.depthMask(false)
      gl.disable(gl.CULL_FACE)
      if (f.alphaMeshes.length) {
        gl.useProgram(this.mesh.p)
        for (const d of f.alphaMeshes) this.drawMesh(d)
        this.disableMesh()
      }
      if (f.dynAlpha.count) {
        gl.useProgram(this.box.p)
        this.env(this.box, f)
        this.bindCube()
        this.uploadDyn(f.dynAlpha.data, f.dynAlpha.count)
        this.drawBoxes(this.dynBuf, f.dynAlpha.count)
        this.unbindInstanced()
      }
      gl.enable(gl.CULL_FACE)
      gl.depthMask(true)
      gl.disable(gl.BLEND)
    }
  }

  private bindCube() {
    const gl = this.gl, a = this.box.a
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cube)
    gl.enableVertexAttribArray(a.a_v)
    gl.vertexAttribPointer(a.a_v, 3, gl.FLOAT, false, 24, 0)
    gl.enableVertexAttribArray(a.a_n)
    gl.vertexAttribPointer(a.a_n, 3, gl.FLOAT, false, 24, 12)
  }

  private unbindInstanced() {
    const gl = this.gl, a = this.box.a
    for (const k of ['i_pos', 'i_q', 'i_size', 'i_col', 'i_mas']) {
      this.inst.divisor(a[k], 0)
      gl.disableVertexAttribArray(a[k])
    }
    gl.disableVertexAttribArray(a.a_v)
    gl.disableVertexAttribArray(a.a_n)
  }

  private drawBoxes(buf: WebGLBuffer, count: number) {
    const gl = this.gl, a = this.box.a, S = BOX_STRIDE * 4
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    const attr = (name: string, size: number, off: number) => {
      const loc = a[name]
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, S, off * 4)
      this.inst.divisor(loc, 1)
    }
    attr('i_pos', 3, 0)
    attr('i_q', 4, 3)
    attr('i_size', 3, 7)
    attr('i_col', 3, 10)
    attr('i_mas', 3, 13)
    this.inst.drawInstanced(36, count)
  }

  private uploadBricks(f: Frame) {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.brickBuf)
    if (this.brickCap !== f.bricks.length) {
      gl.bufferData(gl.ARRAY_BUFFER, f.bricks, gl.DYNAMIC_DRAW)
      this.brickCap = f.bricks.length
    } else if (f.brickDirtyMax > f.brickDirtyMin) {
      const s = f.brickDirtyMin * BOX_STRIDE, e = f.brickDirtyMax * BOX_STRIDE
      gl.bufferSubData(gl.ARRAY_BUFFER, s * 4, f.bricks.subarray(s, e))
    }
  }

  private uploadDyn(data: Float32Array, count: number) {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf)
    const need = count * BOX_STRIDE
    if (this.dynCap < need) {
      this.dynCap = Math.max(need, 4096 * BOX_STRIDE)
      gl.bufferData(gl.ARRAY_BUFFER, this.dynCap * 4, gl.STREAM_DRAW)
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, need))
  }

  private drawMesh(d: MeshDraw) {
    const gl = this.gl, m = this.meshBufs.get(d.mesh)
    if (!m) return
    const p = this.mesh
    gl.uniformMatrix4fv(p.u.u_m, false, d.m)
    if (d.tint) {
      this.tint[0] = d.tint[0]; this.tint[1] = d.tint[1]; this.tint[2] = d.tint[2]; this.tint[3] = 1
    } else this.tint[3] = 0
    gl.uniform4fv(p.u.u_tint, this.tint)
    gl.uniform1f(p.u.u_alpha, d.alpha)
    gl.bindBuffer(gl.ARRAY_BUFFER, m.buf)
    gl.enableVertexAttribArray(p.a.a_v)
    gl.vertexAttribPointer(p.a.a_v, 3, gl.FLOAT, false, 40, 0)
    gl.enableVertexAttribArray(p.a.a_n)
    gl.vertexAttribPointer(p.a.a_n, 3, gl.FLOAT, false, 40, 12)
    gl.enableVertexAttribArray(p.a.a_c)
    gl.vertexAttribPointer(p.a.a_c, 4, gl.FLOAT, false, 40, 24)
    gl.drawArrays(gl.TRIANGLES, 0, m.n)
  }

  private disableMesh() {
    const gl = this.gl, a = this.mesh.a
    gl.disableVertexAttribArray(a.a_v)
    gl.disableVertexAttribArray(a.a_n)
    gl.disableVertexAttribArray(a.a_c)
  }

  destroy() {
    const ext = this.gl.getExtension('WEBGL_lose_context')
    ext?.loseContext()
  }
}
