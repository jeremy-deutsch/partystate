import {
  type Immutable,
  type Patch,
  produceWithPatches,
  enablePatches,
} from "immer";
import type {
  PartyKitConnection,
  PartyKitRoom,
  PartyKitServer,
} from "partykit/server";

export type BuiltInActions =
  | { type: "connect"; params: { [param: string]: any } | null }
  | { type: "close" }
  | { type: "error"; error: Error };

const closeAction = Object.freeze({ type: "close" });

const ON_CONNECT_URL_SEARCH_PARAM = "__onConnectParam";

const STATE_KEY = "$$state";

/**
 * The server state must implement this interface.
 * Only the `public` field will be sent to the client.
 */
interface PartiallyPublic {
  public: any;
}

/**
 * Given a list of patches to an object, returns the patches for patching
 * the `.public` field of that object.
 */
function patchesToPublic(patches: Patch[]): Patch[] {
  const result: Patch[] = [];
  for (const patch of patches) {
    if (patch.path[0] === "public") {
      result.push({ ...patch, path: patch.path.slice(1) });
    }
  }
  return result;
}

async function sendStateToClient<
  StateWrapper extends { state: PartiallyPublic; version: number }
>(websocket: PartyKitConnection, room: PartyKitRoom) {
  const persistedState: Immutable<StateWrapper> | undefined =
    await room.storage.get(STATE_KEY);
  if (persistedState == null) {
    throw new Error("the current state shouldn't disappear!");
  }
  const { state, version } = persistedState;
  websocket.send(
    JSON.stringify({
      type: "state",
      value: { state: state.public, version },
    })
  );
}

/**
 * Creates PartyKit hooks that update and persist the state of a room, plus
 * communicate that state with clients.
 */
export function createHandlers<State extends PartiallyPublic, Action>(
  initialState: Immutable<State>,
  /** Updates the state based on the last event received. */
  reducer: (
    state: State,
    event: { action: Action | BuiltInActions; sender: string }
  ) => undefined,
  options: { persistState?: boolean } = {}
): {
  onConnect: NonNullable<PartyKitServer["onConnect"]>;
  onMessage: NonNullable<PartyKitServer["onMessage"]>;
  onClose: NonNullable<PartyKitServer["onClose"]>;
  onError: NonNullable<PartyKitServer["onError"]>;
} {
  enablePatches();

  interface StateWrapper {
    state: State;
    version: number;
  }

  const persistState = options.persistState ?? false;

  const reducerWithPatches = produceWithPatches(reducer);
  const actualReducer = (
    stateWrapper: Immutable<StateWrapper>,
    action: { action: Action | BuiltInActions; sender: string }
  ): [StateWrapper, Patch[]] | null => {
    const oldState = stateWrapper.state;
    const [newState, patches] = reducerWithPatches(oldState, action);
    if (newState === oldState) {
      return null;
    }
    return [{ state: newState, version: stateWrapper.version + 1 }, patches];
  };

  async function handleAction(
    action: Action | BuiltInActions,
    websocket: PartyKitConnection,
    room: PartyKitRoom
  ) {
    const currentState: Immutable<StateWrapper> | undefined =
      await room.storage.get(STATE_KEY);
    if (currentState == null) {
      throw new Error("the current state shouldn't disappear!");
    }

    const maybeNextState = actualReducer(currentState, {
      action,
      sender: websocket.id,
    });
    if (maybeNextState != null) {
      const [nextState, patches] = maybeNextState;
      room.broadcast(
        JSON.stringify({
          type: "patches",
          patches: patchesToPublic(patches),
          version: nextState.version,
        })
      );
      await room.storage.put(STATE_KEY, nextState);
    }
  }
  return {
    async onConnect(websocket, room, ctx) {
      let currentState: Immutable<StateWrapper> | undefined =
        await room.storage.get(STATE_KEY);
      if (!currentState || (!persistState && room.connections.size === 1)) {
        currentState = { state: initialState, version: 0 };
        await room.storage.put(STATE_KEY, currentState);
      }
      const onConnectParamsString = new URL(ctx.request.url).searchParams.get(
        ON_CONNECT_URL_SEARCH_PARAM
      );
      const onConnectParams = onConnectParamsString
        ? JSON.parse(onConnectParamsString)
        : null;
      await handleAction(
        { type: "connect", params: onConnectParams },
        websocket,
        room
      );
      await sendStateToClient(websocket, room);
    },
    async onMessage(message, websocket, room) {
      if (typeof message === "string") {
        if (message === "$$refresh_state") {
          await sendStateToClient(websocket, room);
        } else {
          const messageJSON = JSON.parse(message);
          await handleAction(messageJSON, websocket, room);
        }
      }
    },
    onClose(websocket, room) {
      handleAction(closeAction, websocket, room);
      if (!persistState && !room.connections.size) {
        room.storage.delete(STATE_KEY);
      }
    },
    onError(websocket, error, room) {
      handleAction({ type: "error", error }, websocket, room);
      if (!persistState && !room.connections.size) {
        room.storage.delete(STATE_KEY);
      }
    },
  };
}
