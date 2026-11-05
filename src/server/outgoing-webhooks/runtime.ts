/** A tiny seam so sources can wake the worker after commit without importing it (avoids a cycle). */
type Wake = () => void;
let wake: Wake | null = null;
export function setOutboxWake(listener: Wake | null): void {
  wake = listener;
}
export function wakeOutbox(): void {
  try {
    wake?.();
  } catch {
    // A failed wake is harmless: the next timer tick still pumps the outbox.
  }
}

type AbortEndpoint = (endpointId: string) => void;
let abortEndpoint: AbortEndpoint | null = null;
export function setEndpointAbortHook(listener: AbortEndpoint | null): void {
  abortEndpoint = listener;
}
export function abortEndpointSends(endpointId: string): void {
  try {
    abortEndpoint?.(endpointId);
  } catch {
    // The row is already cancelled; an in-flight request may still finish remotely.
  }
}

type AbortDelivery = (deliveryId: string) => void;
let abortDelivery: AbortDelivery | null = null;
export function setDeliveryAbortHook(listener: AbortDelivery | null): void {
  abortDelivery = listener;
}
export function abortDeliverySend(deliveryId: string): void {
  try {
    abortDelivery?.(deliveryId);
  } catch {
    // Expiry already marked the row; the request may still complete remotely.
  }
}
