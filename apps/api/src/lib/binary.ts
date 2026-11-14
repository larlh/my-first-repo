import type { FastifyReply } from 'fastify';

/**
 * Send bytes that come from CODE or VERSIONED FILES (stock assets, stock avatar images,
 * built-in template posters): public and cacheable, never user uploads (those go through the
 * signed `/api/files/*` route). Use it for every `binary: true` route of that kind so they
 * all carry the same headers:
 *
 *   defineRoute(app, api.avatars.stockFile, async ({ params, reply }) =>
 *     sendPublicBinary(reply, await getStockPhotorealAvatarFile(params.avatarId, params.file)));
 */
export function sendPublicBinary(
  reply: FastifyReply,
  file: { bytes: Uint8Array; mimeType: string },
  options: { maxAgeSec?: number } = {},
): FastifyReply {
  return (
    reply
      .header('Content-Type', file.mimeType)
      .header('Content-Length', file.bytes.byteLength)
      .header('Cache-Control', `public, max-age=${options.maxAgeSec ?? 86_400}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      // Drawn on canvases and played by the web app, which lives on another origin.
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength))
  );
}
