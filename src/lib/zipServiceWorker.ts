/**
 * Page side of public/zip-sw.js: streams one ZIP of the whole album through a
 * service worker so the browser writes it straight to the Downloads folder.
 */
import type { DownloadResult, ProgressCallback } from "./downloadHelper";

const SW_URL = "/zip-sw.js";
const SW_SCOPE = "/zip-sw/";
const PING_MS = 10_000;
const START_TIMEOUT_MS = 20_000;

export const CANCELLED_MESSAGE = "Download cancelled";

/** Thrown when the worker path couldn't even start, so the caller may try another way. */
export class ServiceWorkerUnavailableError extends Error {}

export function serviceWorkerZipSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    typeof ReadableStream !== "undefined" &&
    typeof MessageChannel !== "undefined"
  );
}

let registration: Promise<ServiceWorkerRegistration> | null = null;

/** Registers the worker early (e.g. when the album opens) so the first click is instant. */
export function prepareZipServiceWorker(): Promise<ServiceWorkerRegistration> | null {
  if (!serviceWorkerZipSupported()) return null;
  if (!registration) {
    registration = navigator.serviceWorker
      .register(SW_URL, { scope: SW_SCOPE, updateViaCache: "none" })
      .catch((error) => {
        registration = null;
        throw error;
      });
    registration.catch(() => undefined);
  }
  return registration;
}

function waitForActive(reg: ServiceWorkerRegistration, timeoutMs: number): Promise<ServiceWorker> {
  if (reg.active) return Promise.resolve(reg.active);
  return new Promise((resolve, reject) => {
    const worker = reg.installing || reg.waiting;
    if (!worker) return reject(new ServiceWorkerUnavailableError("Download helper did not install"));
    const timer = setTimeout(() => reject(new ServiceWorkerUnavailableError("Download helper took too long to start")), timeoutMs);
    const onChange = () => {
      if (worker.state === "activated" && reg.active) {
        clearTimeout(timer);
        worker.removeEventListener("statechange", onChange);
        resolve(reg.active);
      } else if (worker.state === "redundant") {
        clearTimeout(timer);
        reject(new ServiceWorkerUnavailableError("Download helper failed to install"));
      }
    };
    worker.addEventListener("statechange", onChange);
  });
}

function newId(): string {
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

type WorkerMessage =
  | { type: "ready" }
  | { type: "started" }
  | { type: "progress"; done: number; total: number }
  | { type: "done"; saved: number; failed: string[] }
  | { type: "cancelled" }
  | { type: "error"; message: string };

export async function downloadZipViaServiceWorker(
  files: { url: string; name: string }[],
  zipName: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const pending = prepareZipServiceWorker();
  if (!pending) throw new ServiceWorkerUnavailableError("Service workers are not available");
  let worker: ServiceWorker;
  try {
    worker = await waitForActive(await pending, 15_000);
  } catch (error) {
    throw error instanceof ServiceWorkerUnavailableError
      ? error
      : new ServiceWorkerUnavailableError(error instanceof Error ? error.message : "Service worker failed");
  }
  if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);

  const id = newId();
  const channel = new MessageChannel();
  let iframe: HTMLIFrameElement | null = null;
  let ping: ReturnType<typeof setInterval> | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let started = false;

  try {
    return await new Promise<DownloadResult>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      channel.port1.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const msg = event.data;
        switch (msg.type) {
          case "ready": {
            clearTimeout(startTimer);
            iframe = document.createElement("iframe");
            iframe.hidden = true;
            iframe.setAttribute("aria-hidden", "true");
            iframe.src = `${SW_SCOPE}download/${id}/${encodeURIComponent(zipName)}`;
            document.body.appendChild(iframe);
            startTimer = setTimeout(
              () => fail(new ServiceWorkerUnavailableError("The download did not start")),
              START_TIMEOUT_MS,
            );
            break;
          }
          case "started":
            started = true;
            clearTimeout(startTimer);
            // Keep the worker awake for long downloads (browsers stop idle workers).
            ping = setInterval(() => worker.postMessage({ type: "ping" }), PING_MS);
            break;
          case "progress":
            onProgress?.({ current: msg.done, total: msg.total, phase: msg.done >= msg.total ? "finishing" : "downloading" });
            break;
          case "done":
            onProgress?.({ current: files.length, total: files.length, phase: "complete" });
            resolve({ saved: msg.saved, failed: msg.failed });
            break;
          case "cancelled":
            fail(new Error(CANCELLED_MESSAGE));
            break;
          case "error":
            fail(new Error(msg.message || "Download failed"));
            break;
        }
      };
      signal?.addEventListener(
        "abort",
        () => {
          worker.postMessage({ type: "cancel", id });
          fail(new Error(CANCELLED_MESSAGE));
        },
        { once: true },
      );
      worker.postMessage({ type: "job", id, files, zipName }, [channel.port2]);
      startTimer = setTimeout(() => fail(new ServiceWorkerUnavailableError("Download helper did not respond")), 10_000);
    });
  } catch (error) {
    if (!started) worker.postMessage({ type: "cancel", id });
    throw error;
  } finally {
    clearTimeout(startTimer);
    clearInterval(ping);
    channel.port1.close();
    const frame = iframe as HTMLIFrameElement | null;
    // Leave the iframe a while so the browser finishes handing the file to Downloads.
    if (frame) setTimeout(() => frame.remove(), 60_000);
  }
}
