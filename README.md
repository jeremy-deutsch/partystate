# PartyState

Remote state management for PartyKit

Docs to come!

I built a little example game with this: [Word Guesser](https://github.com/jeremy-deutsch/word-guesser)

## Install

```sh
npm install partystate-server partystate-svelte
```

## Example usage

```typescript
// server.ts

interface State {
  public: {
    count: number;
  };
}

type Action = { type: "increment" } | { type: "decrement" };

const handlers = createHandlers(
  { public: { count: 0 } },
  (state: State, event: HandlerEvent<Action>) => {
    switch (event.action.type) {
      case "increment":
        state.public.count++;
      case "decrement":
        state.public.count--;
    }
  }
);

export default handlers satisfies PartyKitServer;

// +page.ts

export const ssr = false;

export const load = (async ({ params }) => {
  const { send, id, stateReadablePromise } = createPartyState<State, Action>({
    host: "localhost:1999", // for local development
    // host: "my-party.username.partykit.dev", // for production
    room: params.room,
  });

  return {
    send,
    stateReadable: await stateReadablePromise,
    id,
  };
}) satisfies PageLoad;
```
