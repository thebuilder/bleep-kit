/* The studio's one assistant: its host over the project and its conversation. */
import { createStudioHost } from "./host.ts";
import { AssistantSession } from "./session.ts";
import { assistantSettings } from "./settings.ts";

const studioHost = createStudioHost();
export const assistantSession = new AssistantSession(
  studioHost,
  assistantSettings
);
