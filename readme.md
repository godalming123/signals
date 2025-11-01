# Signals

[NPM package](https://www.npmjs.com/package/@godalming123/signals)

Push-based type-safe signals library for browsers, [NodeJS](https://nodejs.org/), and [bun](https://bun.com/).

## Todo

- Add tree based signals
- Add more ways to derive from an array signal:
  - `flatMap`
  - `slice`
  - `filter`
  - `flatten`
  - `zip` (several 1D array signals -> one 2D array signal)
  - `unzip` (one 2D array signal -> several 1D array signals)
- Add support for using `spread` with a `Signal<unknown[]>`
- Add an `index` argument to the `ImmutableArray`s `map` function
- Setup a performance benchmark and optimize the code, including cleaning up the code
- Implement moving elements in an array without recomputing the value of the element in the derived arrays
- Detect circular dependencies, and cause an error when they occur
- Do more testing
- Setup eslint and prettier
  - Disallow explicit `any`
  - [Disallow inheritance](https://stackoverflow.com/a/71468931)

## Usage

Install:

```sh
npm install @godalming123/signals
```

Basic example:

```ts
import {state, derive, updateState, effect} from "@godalming123/signals"
const source = state(1)
const derived = derive(() => source.value * 2)
effect(derived, d => console.log(d))
// 2 is printed to the console
updateState(() => source.value += 3)
// 8 is printed to the console
```

For more examples see [the unit tests](https://github.com/godalming123/signals/blob/main/signals.spec.ts).

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
