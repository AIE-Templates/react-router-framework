# Use bounded acknowledged transport and structured cloning

Status: Accepted

## Context

Message ports have no native byte backpressure; WebSocket local drain does not prove remote application progress. Electron MessagePortMain cannot safely transfer arbitrary ArrayBuffer payloads.

## Decision

Use independent request/response and bidirectional channel protocols, explicit byte windows plus connection/frame budgets, bounded relay queues and cancellation. Send exactly sized Uint8Array chunks through structured cloning.

## Consequences

Producers must respect drain/credit. Empty messages still require frame limits. Acknowledgement/drain is not business persistence. Tuning must compare throughput, latency, CPU and retained memory on representative workloads.
