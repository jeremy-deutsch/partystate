import {
  Draft,
  Immutable,
  Objectish,
  Patch,
  applyPatches,
  enablePatches,
  produce,
} from "immer";
import PartySocket, { type PartySocketOptions } from "partysocket";
import { type Readable, derived, writable } from "svelte/store";

let nextEventId = 0;

export function createPartyState<State extends Objectish, Action>(
  partySocketOptions: PartySocketOptions,
  otherOptions: {
    /** If provided, this gets included in the "connect" action on the server. */
    onConnectParams?: { [param: string]: any };
  } = {}
): {
  /** The ID of the underlying PartySocket. */
  id: string;
  /** Sends an Action to be handled by the PartyState server handler. */
  send: (
    /** The Action to have the server handle. */
    event: Action,
    /**
     * Expected changes to apply optimistically to the state.
     * Passes a mutable draft of the state using Immer. */
    optimisticUpdates?: (state: Draft<State>) => void
  ) => Promise<void>;
  /** Once the state is loaded, resolves to a Readable wrapping that state. */
  stateReadablePromise: Promise<Readable<Immutable<State>>>;
} {
  enablePatches();

  let query: Record<string, string> | undefined;
  if (otherOptions.onConnectParams != null) {
    query = {
      ...partySocketOptions.query,
      __onConnectParam: JSON.stringify(otherOptions.onConnectParams),
    };
  } else {
    query = partySocketOptions.query;
  }

  const socket = new PartySocket({ ...partySocketOptions, query });

  const inFlightMessageManager = new InFlightMessageManager<State>();

  function send(
    event: Action,
    optimisticUpdates?: (state: Draft<State>) => void
  ) {
    nextEventId++;
    socket.send(JSON.stringify({ event, id: nextEventId }));
    const onCompletePromise = inFlightMessageManager.getOnCompletePromise(
      nextEventId,
      optimisticUpdates
    );

    if (optimisticUpdates) {
      // Invalidate the state so we re-run optimistic updates
      stateWritable.update((value) => value);
    }

    return onCompletePromise;
  }

  type MessageTypes =
    | { type: "state"; value: { state: Immutable<State>; version: number } }
    | { type: "patches"; patches: Patch[]; version: number }
    | { type: "resolve"; eventId: number; atVersion: number };

  const stateWritable = writable<{
    state: Immutable<State>;
    version: number;
  } | null>(null);
  const queuedPatches = new Map<number, Patch[]>();
  let refreshTimeout: number | null = null;

  function handleMessage(e: MessageEvent) {
    if (typeof e.data === "string") {
      const message: MessageTypes = JSON.parse(e.data);

      if (message.type === "state") {
        inFlightMessageManager.resolveAllInFlightMessages();
      }

      if (message.type === "resolve") {
        inFlightMessageManager.onResolveMessage(message);
      }

      stateWritable.update((current) => {
        // Here we not only generate the new state from the message,
        // but also apply any queued state patches to that new state.

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
        } else if (message.type === "patches") {
          // If a patch doesn't have version [old version + 1], queue it
          // up instead of applying it. This way we always apply state
          // patches in order.
          if (current?.version !== message.version - 1) {
            queuedPatches.set(message.version, message.patches);
            if (refreshTimeout != null) {
              refreshTimeout = setTimeout(() => {
                refreshTimeout = null;
                socket.send("$$refresh_state");
              }, 300);
            }
            return current;
          } else {
            baseState = current.state;
            version = message.version;
            patches.push(...message.patches);
          }
        } else {
          return current;
        }

        // Apply any previously skipped+queued patches.
        while (queuedPatches.has(version + 1)) {
          version++;
          patches.push(...queuedPatches.get(version)!);
          queuedPatches.delete(version);
        }
        if (!queuedPatches.size && refreshTimeout != null) {
          clearTimeout(refreshTimeout);
          refreshTimeout = null;
        }
        inFlightMessageManager.onVersionUpdate(version);
        return { state: applyPatches(baseState, patches), version };
      });
    }
  }

  socket.addEventListener("message", handleMessage);

  const stateReadablePromise = new Promise<Readable<Immutable<State>>>(
    (resolve, reject) => {
      function onStateMessage(e: MessageEvent) {
        const message: MessageTypes = JSON.parse(e.data);
        if (message.type === "state") {
          resolve(
            derived(stateWritable, ($stateWritable) =>
              inFlightMessageManager.runOptimisticUpdates($stateWritable!.state)
            )
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

class InFlightMessageManager<State> {
  #version: number | null = null;

  #inFlight: Array<{
    waitingFor:
      | { type: "version"; version: number }
      | { type: "eventId"; eventId: number };
    resolve: () => void;
    optimisticUpdates: ((state: Draft<State>) => void) | undefined;
  }> = [];

  getOnCompletePromise(
    eventId: number,
    optimisticUpdates: ((state: Draft<State>) => void) | undefined
  ): Promise<void> {
    return new Promise((resolve) => {
      this.#inFlight.push({
        waitingFor: { type: "eventId", eventId },
        resolve,
        optimisticUpdates,
      });
    });
  }

  onResolveMessage(message: {
    type: "resolve";
    eventId: number;
    atVersion: number;
  }) {
    const inFlight = this.#inFlight;
    const newInFlight: typeof inFlight = [];
    for (const inFlightMessage of inFlight) {
      if (
        inFlightMessage.waitingFor.type === "eventId" &&
        inFlightMessage.waitingFor.eventId <= message.eventId
      ) {
        if (this.#version != null && message.atVersion <= this.#version) {
          inFlightMessage.resolve();
        } else {
          inFlightMessage.waitingFor = {
            type: "version",
            version: message.atVersion,
          };
          newInFlight.push(inFlightMessage);
        }
      } else {
        newInFlight.push(inFlightMessage);
      }
    }
    this.#inFlight = newInFlight;
  }

  onVersionUpdate(newVersion: number) {
    this.#version = newVersion;

    const inFlight = this.#inFlight;
    const newInFlight: typeof inFlight = [];
    for (const inFlightMessage of inFlight) {
      if (
        inFlightMessage.waitingFor.type === "version" &&
        inFlightMessage.waitingFor.version <= newVersion
      ) {
        inFlightMessage.resolve();
      } else {
        newInFlight.push(inFlightMessage);
      }
    }
    this.#inFlight = newInFlight;
  }

  resolveAllInFlightMessages() {
    for (const { resolve } of this.#inFlight) {
      resolve();
    }
    this.#inFlight.length = 0;
  }

  runOptimisticUpdates(state: Immutable<State>): Immutable<State> {
    if (
      !this.#inFlight.some(
        (inFlightMessage) => inFlightMessage.optimisticUpdates
      )
    ) {
      return state;
    }

    return produce(state, (draftState: Draft<State>): void => {
      for (const { optimisticUpdates } of this.#inFlight) {
        if (optimisticUpdates) {
          optimisticUpdates(draftState);
        }
      }
    });
  }
}
