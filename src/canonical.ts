const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function normalize(value: unknown, seen: WeakSet<object>): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical data cannot contain non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Canonical data cannot contain cycles");
    seen.add(value);
    const result = value.map((item) => normalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("Canonical data cannot contain cycles");
    seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Canonical data must use plain objects");
    }
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol") {
        throw new Error(`Canonical data contains unsupported value at ${key}`);
      }
      result[key] = normalize(child, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new Error(`Canonical data contains unsupported ${typeof value}`);
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(normalize(value, new WeakSet()));
}

export function canonicalBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(canonicalStringify(value)));
}

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(value));
}

export function fromUtf8(value: BufferSource): string {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return decoder.decode(bytes);
}

export function toBase64Url(value: BufferSource): string {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error("Invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function sha256(value: unknown): Promise<string> {
  const bytes: Uint8Array<ArrayBuffer> =
    value instanceof Uint8Array ? new Uint8Array(value) : canonicalBytes(value);
  return toBase64Url(await crypto.subtle.digest("SHA-256", bytes));
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomId(prefix: string): string {
  return `${prefix}_${toBase64Url(randomBytes(18))}`;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = utf8(left);
  const b = utf8(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % Math.max(1, a.length)] ?? 0) ^ (b[index % Math.max(1, b.length)] ?? 0);
  }
  return difference === 0;
}

export function boundedJsonParse<T>(text: string, maximumBytes: number): T {
  if (utf8(text).byteLength > maximumBytes) throw new Error("Input exceeds size limit");
  const parsed: unknown = JSON.parse(text);
  normalize(parsed, new WeakSet());
  return parsed as T;
}
