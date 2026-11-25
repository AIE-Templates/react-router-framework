/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope | SharedWorkerGlobalScope;

async function echo(port: MessagePort | DedicatedWorkerGlobalScope) {
  try {
    const target = new URL(self.location.href).searchParams.get("echo");
    if (!target) throw new Error("Missing echo URL");
    const response = await fetch(target);
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
