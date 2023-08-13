import {
  Immutable,
  Objectish,
  Patch,
  applyPatches,
  enablePatches,
} from "immer";
import PartySocket, { type PartySocketOptions } from "partysocket";
import { type Readable, derived, writable } from "svelte/store";

export function createPartyState<State extends Objectish, Action>(
  partySocketOptions: PartySocketOptions,
  otherOptions: { onConnectParams?: any } = {}
) {
  enablePatches();

  let query: Record<string, string> | undefined;
  if (otherOptions.onConnectParams) {
    query = {
      ...partySocketOptions.query,
      __onConnectParam: JSON.stringify(otherOptions.onConnectParams),
    };
  } else {
    query = partySocketOptions.query;
  }

  const socket = new PartySocket({ ...partySocketOptions, query });

  // socket.addEventListener("message", (e) => {
  //   console.log("message:", e.data);
  // });

  function send(event: Action) {
    socket.send(JSON.stringify(event));
  }

  type MessageTypes =
    | { type: "state"; value: { state: Immutable<State>; version: number } }
    | { type: "patches"; patches: Patch[]; version: number };

  const stateWritable = writable<{
    state: Immutable<State>;
    version: number;
  } | null>(null);
  const queuedPatches = new Map<number, Patch[]>();
  let refreshTimeout: number | null = null;
  socket.addEventListener("message", (e) => {
    if (typeof e.data === "string") {
      const message: MessageTypes = JSON.parse(e.data);
      stateWritable.update((current) => {
        let baseState: Immutable<State>;
        let version: number;
        const patches: Patch[] = [];

        if (message.type === "state") {
          baseState = message.value.state;
          version = message.value.version;
          for (const patchVersion of queuedPatches.keys()) {
            if (patchVersion <= version) {
              queuedPatches.delete(version);
            }
          }
        } else {
          if (current?.version !== message.version - 1) {
            queuedPatches.set(message.version, message.patches);
            if (refreshTimeout != null) {
              refreshTimeout = setTimeout(() => {
                refreshTimeout = null;
                socket.send("$$refresh_state");
              }, 250);
            }
            return current;
          } else {
            baseState = current.state;
            version = message.version;
            patches.push(...message.patches);
          }
        }

        while (queuedPatches.has(version + 1)) {
          version++;
          patches.push(...queuedPatches.get(version)!);
          queuedPatches.delete(version);
        }
        if (!queuedPatches.size && refreshTimeout != null) {
          clearTimeout(refreshTimeout);
          refreshTimeout = null;
        }
        return { state: applyPatches(baseState, patches), version };
      });
    }
  });

  const stateReadablePromise = new Promise<Readable<Immutable<State>>>(
    (resolve, reject) => {
      function onStateMessage(e: MessageEvent) {
        const message: MessageTypes = JSON.parse(e.data);
        if (message.type === "state") {
          resolve(
            derived(stateWritable, ($stateWritable) => $stateWritable!.state)
          );
          unsubscribe();
        }
      }

      function onDisconnect() {
        reject();
        unsubscribe();
      }

      socket.addEventListener("message", onStateMessage);
      socket.addEventListener("error", onDisconnect);
      socket.addEventListener("close", onDisconnect);

      function unsubscribe() {
        socket.removeEventListener("message", onStateMessage);
        socket.removeEventListener("error", onDisconnect);
        socket.removeEventListener("close", onDisconnect);
      }
    }
  );

  return { send, stateReadablePromise, id: socket.id };
}
