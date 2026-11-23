// WebGL2 planar-YUV renderer (BT.709 / BT.601, limited range) with
// field (bob) display for interlaced material.

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D tY, tU, tV;
uniform vec2 uSize;      // luma texture size
uniform int uField;      // -1 weave, 0 top, 1 bottom
uniform mat3 uMat;
uniform vec3 uOff;
uniform int uMode;       // 0 normal, 1 luma only, 2 safe-area handled in css
out vec4 outColor;
void main() {
  vec2 uv = vUv;
  if (uField >= 0) {
    // bob: sample a single field and interpolate between its lines
    float fieldLines = uSize.y * 0.5;
    float fy = uv.y * fieldLines - 0.5;
    float l0 = floor(fy);
    float t = fy - l0;
    float y0 = (clamp(l0, 0.0, fieldLines - 1.0) * 2.0 + float(uField) + 0.5) / uSize.y;
    float y1 = (clamp(l0 + 1.0, 0.0, fieldLines - 1.0) * 2.0 + float(uField) + 0.5) / uSize.y;
    float Y0 = texture(tY, vec2(uv.x, y0)).r;
    float Y1 = texture(tY, vec2(uv.x, y1)).r;
    float U0 = texture(tU, vec2(uv.x, y0)).r, U1 = texture(tU, vec2(uv.x, y1)).r;
    float V0 = texture(tV, vec2(uv.x, y0)).r, V1 = texture(tV, vec2(uv.x, y1)).r;
    vec3 yuv = vec3(mix(Y0, Y1, t), mix(U0, U1, t), mix(V0, V1, t));
    vec3 rgb = uMat * (yuv - uOff);
    if (uMode == 1) rgb = vec3((yuv.x - uOff.x) * uMat[0][0]);
    outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
    return;
  }
  vec3 yuv = vec3(texture(tY, uv).r, texture(tU, uv).r, texture(tV, uv).r);
  vec3 rgb = uMat * (yuv - uOff);
  if (uMode == 1) rgb = vec3((yuv.x - uOff.x) * uMat[0][0]);
  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

// column-major mat3 for (Y-16/255, U-128/255, V-128/255) -> RGB, limited range
const M709 = [1.164383, 1.164383, 1.164383, 0, -0.213249, 2.112402, 1.792741, -0.532909, 0];
const M601 = [1.164383, 1.164383, 1.164383, 0, -0.391762, 2.017232, 1.596027, -0.812968, 0];

export class YuvRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, alpha: false });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.prog = prog;
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = ['tY', 'tU', 'tV'].map((name, i) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(prog, name), i);
      return t;
    });
    this.u = {
      size: gl.getUniformLocation(prog, 'uSize'),
      field: gl.getUniformLocation(prog, 'uField'),
      mat: gl.getUniformLocation(prog, 'uMat'),
      off: gl.getUniformLocation(prog, 'uOff'),
      mode: gl.getUniformLocation(prog, 'uMode'),
    };
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.dims = '';
    this.field = -1;
    this.mode = 0;
    this.matrix = 'auto';
    this.last = null;
  }

  /** frame = { yuv:Uint8Array, offset, w, h, cw, ch, srcH } */
  draw(f) {
    const gl = this.gl;
    this.last = f;
    const key = `${f.w}x${f.h}/${f.cw}x${f.ch}`;
    const ySize = f.w * f.h, cSize = f.cw * f.ch;
    const base = f.offset;
    const planes = [
      [f.w, f.h, f.yuv.subarray(base, base + ySize)],
      [f.cw, f.ch, f.yuv.subarray(base + ySize, base + ySize + cSize)],
      [f.cw, f.ch, f.yuv.subarray(base + ySize + cSize, base + ySize + 2 * cSize)],
    ];
    planes.forEach(([w, h, data], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[i]);
      if (key !== this.dims) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
    });
    this.dims = key;
    if (this.canvas.width !== f.w || this.canvas.height !== f.h) {
      this.canvas.width = f.w;
      this.canvas.height = f.h;
    }
    this._paint(f);
  }

  redraw() { if (this.last) this._paint(this.last); }

  _paint(f) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const hd = this.matrix === '709' || (this.matrix === 'auto' && (f.srcH || f.h) >= 720);
    gl.uniformMatrix3fv(this.u.mat, false, hd ? M709 : M601);
    gl.uniform3f(this.u.off, 16 / 255, 128 / 255, 128 / 255);
    gl.uniform2f(this.u.size, f.w, f.h);
    gl.uniform1i(this.u.field, f.progressive ? -1 : this.field);
    gl.uniform1i(this.u.mode, this.mode);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
