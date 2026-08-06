"use client";

import { PIN_LENGTH } from "./protocol";

/**
 * A PIN closes the one real gap in a QR-only handshake: the code is a bearer
 * token, so anyone who photographs it, shoulder-surfs it, or catches it in a
 * screen share can claim the transfer — and because sessions are single-use, a
 * snooper who acts first wins the race against the intended recipient.
 *
 * The PIN travels out of band (you read it aloud), so the code alone stops being
 * enough.
 *
 * What actually makes a 6-digit secret safe here is the server's attempt limit,
 * not the hashing below. Six digits is a million possibilities: trivially
 * brute-forced if guesses were unlimited, and hopeless at five. The digest is
 * hygiene — it keeps the PIN out of the wire and out of server logs — not a
 * defence against the server itself, which could brute-force a 6-digit digest
 * instantly and can already see every SDP it relays.
 */

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Rejection sampling, so every digit is equally likely rather than skewed by a modulo. */
export function generatePin(): string {
  const digits: string[] = [];
  const buf = new Uint8Array(1);
  while (digits.length < PIN_LENGTH) {
    crypto.getRandomValues(buf);
    // 250 is the largest multiple of 10 below 256; anything above biases low digits.
    if (buf[0] >= 250) continue;
    digits.push(String(buf[0] % 10));
  }
  return digits.join("");
}

export function randomSalt(): string {
  return randomHex(16);
}

export async function pinDigest(salt: string, pin: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Groups a PIN for reading aloud: "428 913" is easier to say than "428913". */
export function formatPin(pin: string): string {
  const mid = Math.ceil(pin.length / 2);
  return `${pin.slice(0, mid)} ${pin.slice(mid)}`.trim();
}
