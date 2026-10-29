import { API_BASE } from "./api";

/** Dev assets come from Vite; release assets are streamed by the local backend. */
export function runtimeAssetBase(): string {
  return import.meta.env.DEV
    ? document.baseURI
    : `${API_BASE.replace(/\/+$/, "")}/api/runtime-assets/`;
}
