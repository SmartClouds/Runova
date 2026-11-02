/**
 * Telling a real GPU from a software one before the beam (beam.ts) commits to WebGL.
 *
 * `failIfMajorPerformanceCaveat` is meant to refuse software rendering, but headless Chrome still
 * hands out a SwiftShader context with it set, and a Linux desktop without GPU drivers may get
 * Mesa's llvmpipe. There each beam frame blocks the main thread for about 55ms, so the CSS line
 * is the better beam.
 */

/**
 * Renderer names of GL drivers that draw on the CPU: SwiftShader, Mesa's llvmpipe and softpipe,
 * and Microsoft's Basic Render Driver.
 */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render driver/i;

export function isSoftwareRenderer(name: string): boolean {
  return SOFTWARE_RENDERER.test(name);
}

/** The context's renderer, unmasked where the browser allows it. */
export function rendererName(gl: WebGLRenderingContextBase): string {
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  return typeof name === 'string' ? name : '';
}
