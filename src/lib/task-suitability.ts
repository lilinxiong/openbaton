import type { ModelCard } from "../types.js";

export interface TaskCapabilityExclusion {
  model_id: string;
  route_id: string;
  provider: string | null;
  code: "TASK_CAPABILITY_MISMATCH";
  reason: string;
}
const NON_AGENT_TEXT_ROUTE = /(?:^|[\/_-])(?:asr|tts|voiceclone|voicedesign)(?=$|[.@/_-])/i;

export function taskCapabilityExclusion(card: ModelCard): TaskCapabilityExclusion | null {
  const routeId = String(card.route_id || card.id || "");
  if (!NON_AGENT_TEXT_ROUTE.test(routeId) && !NON_AGENT_TEXT_ROUTE.test(card.id)) return null;
  return {
    model_id: card.id,
    route_id: routeId,
    provider: card.provider || null,
    code: "TASK_CAPABILITY_MISMATCH",
    reason: "current Baton work units require text reasoning/tool use; ASR, TTS, voice-clone, and voice-design routes are not eligible",
  };
}
