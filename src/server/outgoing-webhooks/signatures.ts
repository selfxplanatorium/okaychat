import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WEBHOOK_KEY_PREFIX, WEBHOOK_SECRET_PREFIX } from "../../shared/outgoing-webhooks.js";

/**
 * HMAC-SHA256 over `timestamp + '.' + deliveryId + '.'` followed by the exact stored body bytes.
 * The whole secret string is the key (prefix included), so a receiver copies what it was shown.
 */

export const webhookSecret = (): string => `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
export const webhookKeyId = (): string => `${WEBHOOK_KEY_PREFIX}${randomBytes(9).toString("base64url")}`;

export function signatureInput(timestamp: number, deliveryId: string, body: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.${deliveryId}.`, "utf8"), Buffer.from(body)]);
}

export function signDelivery(secret: string, timestamp: number, deliveryId: string, body: Uint8Array): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(signatureInput(timestamp, deliveryId, body)).digest("hex");
}

/** Constant-time verification, exported for the documented receiver algorithm and its test vector. */
export function verifyDelivery(secret: string, timestamp: number, deliveryId: string, body: Uint8Array, signature: string): boolean {
  const expected = Buffer.from(signDelivery(secret, timestamp, deliveryId, body), "utf8");
  const actual = Buffer.from(signature, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
