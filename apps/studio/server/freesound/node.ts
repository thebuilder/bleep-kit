/* An adapter from node:http to the web standard handler, for the two places that are not a Vercel Function: the Vite dev
   server and the CLI's studio server. The types are structural (no import of node:http), so this file typechecks in the
   studio's browser configuration too. */

import { type HandlerDeps, handleFreesound } from "./handler.ts";
import { FREESOUND_BASE } from "./protocol.ts";

interface NodeRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
  url?: string | undefined;
}

interface NodeResponse {
  end: (chunk?: Uint8Array) => unknown;
  writeHead: (status: number, headers: Record<string, string>) => unknown;
}

/** True for a path this adapter answers. */
export const isFreesoundPath = (url: string | undefined): boolean =>
  url?.startsWith(`${FREESOUND_BASE}/`) ?? false;

function toRequest(req: NodeRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      headers.set(name, value.join(", "));
    }
  }
  // the server in front of a Vercel Function sets this; here the socket is the only source
  headers.delete("x-forwarded-for");
  headers.delete("x-vercel-forwarded-for");
  if (req.socket?.remoteAddress) {
    headers.set("x-forwarded-for", req.socket.remoteAddress);
  }
  return new Request(`http://localhost${req.url ?? "/"}`, {
    headers,
    method: req.method ?? "GET",
  });
}

/** Answer a /api/freesound/ request. Resolves once the response is written. */
export async function serveFreesound(
  req: NodeRequest,
  res: NodeResponse,
  deps: HandlerDeps = {}
): Promise<void> {
  const out = await handleFreesound(toRequest(req), deps);
  const headers: Record<string, string> = {};
  out.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(out.status, headers);
  res.end(new Uint8Array(await out.arrayBuffer()));
}
