/* The Vercel Function for /api/freesound/* when the Vercel project's Root Directory is apps/studio. When the project
   builds from the repository root, the twin file at the repository root (api/freesound/[...path].ts) is the one
   Vercel deploys instead. Both only call the shared handler in server/freesound/, where the code lives. */
import { handleFreesound } from "../../server/freesound/handler.ts";

export function GET(request: Request): Promise<Response> {
  return handleFreesound(request);
}
