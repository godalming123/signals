# signals

[NPM package](https://www.npmjs.com/package/@godalming123/signals)

TODO: Fast push-based type-safe signals library for browsers, NodeJS, and bun.

## Usage

```sh
npm install @godalming123/signals
```

```ts
import {state, derive, updateState, effect} from "@godalming123/signals"
const source = state(1)
const derived = derive(() => source.value * 2)
effect(derived, d => console.log(d))
// 2 is printed to the console
updateState(() => source.value += 3)
// 8 is printed to the console
```

## Development

To install dependencies:

```sh
bun install
```

To type check:

```sh
bun run check
```

To test:

```sh
bun run test
```

To debug:

```sh
bun run debug
```

To publish to NPM:

```sh
bun run build
bun publish --scope=public
```

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=godalming123/signals&type=date&legend=bottom-right)](https://www.star-history.com/#godalming123/signals&type=date&legend=bottom-right)
