// Mounting an MCP endpoint. Ported from whatsapp2ai's src/mcp.ts, which grew this shape because the
// single-account route and the per-tenant route had each carried their own copy — and a fix to one
// (the 500-with-a-stack when a lookup failed) had to be remembered for the other.
//
// The only thing that differs between those routes is how a request becomes a Ctx, so that is the
// parameter. Stage 4's /c/<token>/mcp will pass a different resolver and nothing else.
import type { Express, Request, Response } from 'express';
import type pino from 'pino';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer, type Ctx } from './tools.ts';

/**
 * What a request resolves to. `null` means no such connector — answer 404 and say nothing more.
 * `{ unavailable }` means it exists but cannot serve right now: a different answer, because telling
 * a working connector "not found" looks to its owner exactly like a revoked URL.
 */
export type McpResolution = Ctx | null | { unavailable: string } | { tooMany: string; retryAfter: number };

export type McpResolver = (req: Request, res: Response) => Promise<McpResolution> | McpResolution;

const isUnavailable = (r: McpResolution): r is { unavailable: string } => r !== null && typeof r === 'object' && 'unavailable' in r;
const isTooMany = (r: McpResolution): r is { tooMany: string; retryAfter: number } => r !== null && typeof r === 'object' && 'tooMany' in r;

/** GET and DELETE are not part of this transport's contract; say so rather than 404ing. */
const notAllowed = (_req: Request, res: Response) =>
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });

export function mountMcp(app: Express, pattern: string, resolve: McpResolver, log: pino.Logger): void {
  app.post(pattern, async (req: Request, res: Response) => {
    let target: McpResolution;
    try {
      target = await resolve(req, res);
    } catch (e) {
      // A resolver failing is "try again", not "you do not exist".
      log.error({ err: String(e) }, 'could not resolve an MCP connector');
      res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Temporarily unavailable.' }, id: null });
      return;
    }

    if (target === null) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    if (isUnavailable(target)) {
      res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: target.unavailable }, id: null });
      return;
    }
    // 429 with Retry-After, so a client that reads it backs off rather than tightening the loop.
    if (isTooMany(target)) {
      res.status(429).set('Retry-After', String(target.retryAfter)).json({ jsonrpc: '2.0', error: { code: -32000, message: target.tooMany }, id: null });
      return;
    }

    // A fresh server and transport per request: the endpoint is stateless, and the state that
    // matters lives in the GSC client behind this Ctx.
    const server = buildServer(target);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      // The body is already parsed by express.json(), which is also where the size cap lives — this
      // transport has no size option of its own.
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log.error({ err: String(e) }, 'mcp request failed');
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  app.get(pattern, notAllowed);
  app.delete(pattern, notAllowed);
}
