import { fetch } from '@forge/api';
import type { HttpFetch } from './paystack';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export const forgeHttp: HttpFetch = async (url, init) => {
  const body = init.body instanceof Uint8Array ? toArrayBuffer(init.body) : init.body;
  const res = await fetch(url, { method: init.method, headers: init.headers, body });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};
