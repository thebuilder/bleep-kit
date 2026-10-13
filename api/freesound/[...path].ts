/* The Vercel Function for /api/freesound/* when the Vercel project builds from the repository root. When its Root
   Directory is apps/studio, the twin file apps/studio/api/freesound/[...path].ts is the one Vercel deploys instead
   (a Root Directory cannot reach files above it, so the code itself lives inside apps/studio/server/freesound/).
   Both only call the shared handler. */
import { handleFreesound } from "../../apps/studio/server/freesound/handler.ts";

export function GET(request: Request): Promise<Response> {
  return handleFreesound(request);
}
