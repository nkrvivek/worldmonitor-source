/**
 * Wraps api/wm-session.js — the anonymous wms_ session minter — for direct
 * use inside the Worker, instead of proxying /api/wm-session to Vercel.
 *
 * Plan 2026-08-03-p4d, Task 4. The 19 non-premium market RPCs ported to the
 * Worker in Task 2 all require a wms_-prefixed session cookie
 * (server/gateway.ts's validateApiKey path). Nothing minted that cookie in
 * the Worker until this route exists — the browser's only source for it is
 * POST /api/wm-session (src/services/wm-session.ts), and that endpoint had
 * no Worker equivalent, so every ported market route returned 401 with no
 * session cookie present.
 *
 * The session is anonymous and freely mintable by design (see the comment at
 * server/gateway.ts:1162) — this grants no privilege beyond what the old
 * Vercel deployment already granted to every visitor.
 */
import type { GatewayCtx } from '../../server/gateway';
// @ts-expect-error — JS module, no declaration file
import handler from '../../api/wm-session.js';

export const WM_SESSION_PATH = '/api/wm-session';

export async function handleWmSession(request: Request, ctx?: GatewayCtx): Promise<Response> {
  return handler(request, ctx);
}
