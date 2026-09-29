import { formatProgressNotification, dispatchProgressNotification, type ProgressNotificationAdapter, type ProgressNotificationDispatchResult } from "./progress-notifications.js";
import type { WebProductEventBus, WebProductEvent } from "../web-control-plane/event-bus.js";

export type ProgressEventBridgeOptions = {
  eventBus: WebProductEventBus;
  durableRoot: string;
  adapter: ProgressNotificationAdapter;
  onResult?: (event: WebProductEvent, result: ProgressNotificationDispatchResult) => void;
};

export function connectProgressEventBridge(options: ProgressEventBridgeOptions): () => void {
  return options.eventBus.subscribe((event) => {
    const scope = event.scope ?? {};
    const payload = event.payload ?? {};
    const notification = formatProgressNotification({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
      ...(scope.campaignId ? { campaignId: scope.campaignId } : {}),
      ...(scope.runId ? { runId: scope.runId } : {}),
      ...(typeof payload.status === "string" ? { status: payload.status } : {}),
      ...(typeof payload.blocker === "string" ? { summary: payload.blocker } : typeof payload.change === "string" ? { summary: payload.change } : {}),
    });
    if (!notification) return;
    void dispatchProgressNotification(options.durableRoot, notification, options.adapter)
      .then((result) => options.onResult?.(event, result))
      .catch(() => undefined);
  });
}
