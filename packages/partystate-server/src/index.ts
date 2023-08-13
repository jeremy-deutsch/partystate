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

export function createHandlers<State, Action>(
  initialState: Immutable<State>,
  reducer: (
    state: State,
    action: { action: Action | BuiltInActions; sender: string }
  ) => undefined,
  options: {
    persistState?: boolean;
  } = {}
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
        JSON.stringify({ type: "patches", patches, version: nextState.version })
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
      websocket.send(
        JSON.stringify({
          type: "state",
          value: await room.storage.get(STATE_KEY),
        })
      );
    },
    async onMessage(message, websocket, room) {
      if (typeof message === "string") {
        if (message === "$$refresh_state") {
          websocket.send(
            JSON.stringify({
              type: "state",
              value: await room.storage.get(STATE_KEY),
            })
          );
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
