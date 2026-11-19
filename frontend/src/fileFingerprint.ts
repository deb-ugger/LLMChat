/** SHA-256 hex digest of file bytes (already loaded in memory). */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

const blobFingerprints = new WeakMap<Blob, Promise<string>>();

/** Reuse the digest when more than one stage receives the same immutable bytes. */
export function blobSha256Hex(blob: Blob): Promise<string> {
  const existing = blobFingerprints.get(blob);
  if (existing) return existing;
  const digest = blob.arrayBuffer().then(sha256Hex).catch(error => {
    blobFingerprints.delete(blob);
    throw error;
  });
  blobFingerprints.set(blob, digest);
  return digest;
}
