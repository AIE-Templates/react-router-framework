/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope | SharedWorkerGlobalScope;

async function echo(port: MessagePort | DedicatedWorkerGlobalScope) {
  try {
    const params = new URL(self.location.href).searchParams;
    const target = params.get("echo");
    if (!target) throw new Error("Missing echo URL");
    const response = await fetch(target, { credentials: params.has("omit") ? "omit" : "same-origin" });
    port.postMessage([response.status, await response.text()]);
  } catch (error) {
    port.postMessage([0, String(error)]);
  }
}

if ("onconnect" in self) {
  self.addEventListener("connect", (event) => void echo(event.ports[0]));
} else {
  void echo(self);
}
