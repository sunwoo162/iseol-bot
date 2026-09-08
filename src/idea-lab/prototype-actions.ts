import type { PrototypeCandidate } from "../project-model/contracts.js";
import { loadPrototypeCandidate, updatePrototypeCandidate } from "../project-model/prototype-store.js";

export async function archivePrototypeCandidate(
  modelRoot: string,
  prototypeId: string,
  at: string,
): Promise<PrototypeCandidate> {
  const candidate = await loadPrototypeCandidate(modelRoot, prototypeId);
  if (!candidate) throw new Error(`Prototype not found: ${prototypeId}`);
  if (candidate.status === "promoted") {
    throw new Error(`Promoted prototype cannot be archived: ${prototypeId}`);
  }
  if (candidate.status === "archived") return candidate;
  const updated = await updatePrototypeCandidate(modelRoot, prototypeId, {
    status: "archived",
    updatedAt: at,
  });
  if (!updated) throw new Error(`Prototype not found: ${prototypeId}`);
  return updated;
}
