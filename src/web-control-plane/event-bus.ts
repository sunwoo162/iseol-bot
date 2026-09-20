import { randomUUID } from "node:crypto";

export type WebProductEvent = {
  id: string;
  type: string;
  occurredAt: string;
  scope?: { projectId?: string; campaignId?: string; prototypeId?: string; runId?: string };
  payload: Record<string, unknown>;
};

export type WebProductEventInput = Omit<WebProductEvent, "id" | "occurredAt"> & { occurredAt?: string };
export type WebProductEventListener = (event: WebProductEvent) => void;

/**
 * Process-local refresh signal bus. Durable stores remain the source of truth;
 * clients re-fetch after receiving an event. No replay is claimed here.
 */
export class WebProductEventBus {
  private readonly listeners = new Set<WebProductEventListener>();
  private sequence = 0;

  publish(input: WebProductEventInput): WebProductEvent {
    const event: WebProductEvent = {
      id: `${Date.now().toString(36)}-${(++this.sequence).toString(36)}-${randomUUID()}`,
      type: input.type,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      ...(input.scope ? { scope: { ...input.scope } } : {}),
      payload: { ...input.payload },
    };
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* observers must not break domain actions */ }
    }
    return event;
  }

  subscribe(listener: WebProductEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number { return this.listeners.size; }
}
