---
name: pues-sse-setup
description: Mount the Pues SSE route, broadcast per-user events from mutations, and subscribe on the client. Use when wiring live updates, bridging non-Pues writes, or reasoning about Last-Event-ID replay and op_id echo suppression.
---
# Pues SSE Setup

## Goal
One authenticated, per-user event stream that keeps `useResource` (and any
custom subscribers) coherent across every write surface in the service.

## 1) Mount Once on the Server
`sseRoute()` returns `{ routes, broadcast, streamCount }`. Mount the routes,
keep `broadcast` around, and pass it into every component that emits.

```ts
import { sseRoute } from "pues/base/sse";
import { resolveUser } from "pues/base/auth/server";

export const puesSse = sseRoute({ resolveUser }); // default path /api/events

export default {
  routes: {
    ...puesSse.routes,
    ...mountAuthRoutes(),
    // resources receive puesSse.broadcast — see [[../pues-objects-resource-setup/SKILL.md|pues-objects-resource-setup]]
  },
};
```

Anonymous requests (`resolveUser → null`) get 401 by design — SSE always
implies an authenticated stream. Public-read data still flows over REST.

## 2) Emit on Mutations
- Pues CRUD: pass `broadcast: puesSse.broadcast` into each `mountResource`.
- Custom mutation handlers: call `puesSse.broadcast(userId, "thing.updated", row, { op_id })`.
- Non-Pues writes (webhooks, jobs, raw SQL paths): use the row-shape bridges
  in `pues/base/objects` so subscribers can't tell native from bridged:
  - `broadcastRow(broadcast, userId, name, "created"|"updated", wireRow, { op_id })`
  - `broadcastDelete(broadcast, userId, name, id, { parent_id, op_id })`

Bridges intentionally cover only `.created` / `.updated` / `.deleted`.
`.reordered` has a different payload shape and is not bridged — emit it
directly via `broadcast(...)` if you need it outside Pues routes.

## 3) Subscribe on the Client
Prefer `useResource` — it wires `useSSE` for you with the right event names.
Reach for `useSSE` directly only for streams outside the resource model
(notifications, presence, custom channels).

```tsx
import { useSSE } from "pues/base/sse";

const { newOpId } = useSSE({
  "notifications.created": (data) => addToast(data),
});

async function send() {
  const op_id = newOpId(); // server echo carrying this op_id will be dropped
  await fetch("/api/notify", { method: "POST", body: JSON.stringify({ op_id }) });
}
```

## Reconnect Semantics
- Each broadcast carries a monotonic `id:` and lands in a per-user ring buffer
  (default 200 events).
- Native `EventSource` auto-sends `Last-Event-ID` on reconnect: strictly newer
  ring entries replay before going live.
- If the id is unknown (process restart, ring eviction), the client receives
  a single synthetic `resync` event — rebuild state from REST.
- Set `ringMax: 0` to disable replay entirely (always `resync` on reconnect).

## Checklist
- [ ] `sseRoute()` is called exactly once per process.
- [ ] Every mutation surface — Pues routes, custom handlers, webhooks — feeds
      the same `broadcast`.
- [ ] Optimistic-UI callers mint an `op_id` via `newOpId()` and include it on
      the write so the server echo is dropped.
- [ ] Event names follow `<resource>.created|updated|deleted|reordered`.
- [ ] Clients tolerate `resync` by reloading from REST, not by erroring.
