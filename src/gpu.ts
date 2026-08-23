/**
 * The one place a shader runs.
 *
 * Some effects cannot be expressed as a canvas filter, a blend mode or a
 * shape: keying a colour out of a picture is a decision taken per pixel. That
 * does NOT mean the renderer has to become a WebGL renderer. A frame goes
 * through a shader here, comes back out as something `drawImage` accepts, and
 * the render function draws it exactly as it draws a decoded frame - so the
 * transform, the mask, the blend mode, the transitions and the text all keep
 * working without knowing anything about this.
 *
 * Measured before it was built: a VideoFrame uploads as a WebGL2 texture, and
 * a 2D context can draw the result back with the alpha intact.
 *
 * The context is cached per owner. Contexts are a scarce resource - a browser
 * will drop the oldest once a page has a dozen or so - and one per frame would
 * exhaust them within a second of playback.
 */

const VERTEX_SHADER = `#version 300 es
in vec2 position;
out vec2 uv;

void main() {
  // The texture arrives with its origin at the top, so v is flipped here
  // rather than by uploading the frame upside down.
  uv = vec2((position.x + 1.0) / 2.0, 1.0 - (position.y + 1.0) / 2.0);
  gl_Position = vec4(position, 0.0, 1.0);
}`

/**
 * Keying is decided on CHROMA alone, not on the colour as a whole.
 *
 * A green screen is never evenly lit: the same green is darker in the corners
 * and brighter under the light, so a distance in RGB rejects half of it. The
 * chroma pair says what colour something is regardless of how much light fell
 * on it, which is the question being asked.
 */
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 uv;
out vec4 colour;

uniform sampler2D frame;
uniform vec3 keyColour;
uniform float similarity;
uniform float smoothness;
uniform float spill;

vec2 chromaOf(vec3 rgb) {
  return vec2(
    -0.169 * rgb.r - 0.331 * rgb.g + 0.500 * rgb.b,
     0.500 * rgb.r - 0.419 * rgb.g - 0.081 * rgb.b
  );
}

void main() {
  vec4 texel = texture(frame, uv);
  float distance = length(chromaOf(texel.rgb) - chromaOf(keyColour));

  // Below similarity it is the key colour and goes entirely; above
  // similarity + smoothness it is kept entirely; between the two it is an
  // edge, and a hard cut there is what makes a bad key look cut out.
  float alpha = smoothstep(similarity, similarity + smoothness, distance);

  vec3 kept = texel.rgb;
  if (spill > 0.0) {
    // What survives near the key colour is fringed with it. Draining that
    // towards the pixel's own brightness is what stops green edges on hair.
    float nearness = 1.0 - clamp(distance / max(similarity, 0.0001), 0.0, 1.0);
    float luma = dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722));
    kept = mix(kept, vec3(luma), spill * nearness);
  }

  colour = vec4(kept, texel.a * alpha);
}`

export type ChromaKeySettings = {
  color: string
  similarity: number
  smoothness: number
  spill: number
}

type Pass = {
  canvas: OffscreenCanvas
  gl: WebGL2RenderingContext
  program: WebGLProgram
  texture: WebGLTexture
  uniforms: {
    keyColour: WebGLUniformLocation | null
    similarity: WebGLUniformLocation | null
    smoothness: WebGLUniformLocation | null
    spill: WebGLUniformLocation | null
  }
}

/** One pass per owner: the preview thread and the export worker each get one. */
const passes = new WeakMap<object, Pass | null>()

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Could not create a shader.')

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Shader would not compile: ${log ?? 'no reason given'}`)
  }

  return shader
}

function createPass(): Pass | null {
  if (typeof OffscreenCanvas === 'undefined') return null

  const canvas = new OffscreenCanvas(1, 1)
  const gl = canvas.getContext('webgl2', {
    // Straight alpha in and out, so what the shader writes is what the 2D
    // context receives rather than something already multiplied through.
    premultipliedAlpha: false,
    // The result is drawn out AFTER the draw call returns, so the buffer has
    // to survive it.
    preserveDrawingBuffer: true,
    antialias: false,
    depth: false,
  })
  if (!gl) return null

  try {
    const program = gl.createProgram()
    if (!program) return null

    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER))
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
    gl.linkProgram(program)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'link failed')
    }
    gl.useProgram(program)

    // One triangle big enough to cover the frame, which needs no index buffer
    // and no second vertex than the three.
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    )

    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    const texture = gl.createTexture()
    if (!texture) return null

    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    return {
      canvas,
      gl,
      program,
      texture,
      uniforms: {
        keyColour: gl.getUniformLocation(program, 'keyColour'),
        similarity: gl.getUniformLocation(program, 'similarity'),
        smoothness: gl.getUniformLocation(program, 'smoothness'),
        spill: gl.getUniformLocation(program, 'spill'),
      },
    }
  } catch (error) {
    console.warn('[gpu] no shader pass available:', error)
    return null
  }
}

function passFor(owner: object): Pass | null {
  if (passes.has(owner)) return passes.get(owner) ?? null

  const pass = createPass()
  passes.set(owner, pass)
  return pass
}

/** '#rrggbb' as three values from 0 to 1. Anything else keys pure green. */
export function parseColour(value: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim())
  if (!match) return [0, 1, 0]

  const number = Number.parseInt(match[1]!, 16)
  return [
    ((number >> 16) & 255) / 255,
    ((number >> 8) & 255) / 255,
    (number & 255) / 255,
  ]
}

/**
 * Runs a frame through the key and hands back something drawable.
 *
 * Returns null when there is no WebGL to be had, which the caller treats as a
 * reason to draw the frame unkeyed - a picture with its background still in it
 * beats no picture at all.
 */
export function keyFrame(
  owner: object,
  frame: CanvasImageSource,
  width: number,
  height: number,
  settings: ChromaKeySettings,
): CanvasImageSource | null {
  if (width <= 0 || height <= 0) return null

  const pass = passFor(owner)
  if (!pass) return null

  const { canvas, gl, texture, uniforms } = pass

  try {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }

    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      frame as TexImageSource,
    )

    const [r, g, b] = parseColour(settings.color)
    gl.uniform3f(uniforms.keyColour, r, g, b)
    gl.uniform1f(uniforms.similarity, settings.similarity)
    gl.uniform1f(uniforms.smoothness, Math.max(0.0001, settings.smoothness))
    gl.uniform1f(uniforms.spill, settings.spill)

    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    return canvas
  } catch (error) {
    console.warn('[gpu] could not key a frame:', error)
    return null
  }
}
