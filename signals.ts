// TODO:
// - Create an error when there are circular dependencies
// - Add support for using functions like `map`, `flatMap`, and `filter` on a signal that holds an array or an object to create a derived signal with minimal state recalculations
// - Perform further testing
// - Add a way to benchmark this
// - Optimization this

type GeneralTracker<T> = {
  value: T,
  downstreamSignals: Set<DerivedTracker<unknown>>,
  downstreamEffects: Set<() => void>,
}
type DerivedTracker<T> = GeneralTracker<T> & {type: "derived", upstreamSignals: Set<Tracker<unknown>>, func: () => T}
type StateTracker<T> = GeneralTracker<T> & {type: "state"}
type Tracker<T> = DerivedTracker<T> | StateTracker<T>

type State = {
  mode: "normal"
} | {
  mode: "creating-derived-signal"
  derivationsBeingComputed: [DerivedTracker<unknown>]
} | {
  mode: "running-effect(s)"
} | {
  mode: "updating-state",
  staleDerivedSignals: Set<DerivedTracker<unknown>>,
  staleEffects: Set<() => void>,
} | {
  mode: "updating-derived-signals",
  staleDerivedSignals: Set<DerivedTracker<unknown>>,
  staleEffects: Set<() => void>,
  freshDerivedSignals: Set<DerivedTracker<unknown>>, // Derived signals that have been updated this update cycle
  derivationsBeingComputed: DerivedTracker<unknown>[]
}

let stateData: State = {mode: "normal"}

function getDerivationBeingComputed(): DerivedTracker<unknown> | undefined {
  if ((stateData.mode === "creating-derived-signal" || stateData.mode === "updating-derived-signals")
    && stateData.derivationsBeingComputed.length > 0) {
    return stateData.derivationsBeingComputed[stateData.derivationsBeingComputed.length-1]
  }
  return undefined
}

function removeTrackerDependencies(tracker: DerivedTracker<unknown>) {
  for (const dependency of tracker.upstreamSignals) {
    const removed = dependency.downstreamSignals.delete(tracker)
    if (removed !== true) {
      throw new Error("Unreachable")
    }
  }
  tracker.upstreamSignals = new Set()
}

function updateDerivedSignal(derivedSignal: DerivedTracker<unknown>) {
  if (stateData.mode !== "updating-derived-signals") throw new Error("Unreachable")
  stateData.staleDerivedSignals.delete(derivedSignal)
  removeTrackerDependencies(derivedSignal)
  const oldValue = derivedSignal.value
  stateData.derivationsBeingComputed.push(derivedSignal)
  derivedSignal.value = derivedSignal.func()
  stateData.derivationsBeingComputed.pop()
  stateData.freshDerivedSignals.add(derivedSignal)
  if (derivedSignal.value !== oldValue) {
    for (const signal of derivedSignal.downstreamSignals) {
      stateData.staleDerivedSignals.add(signal)
    }
    for (const effect of derivedSignal.downstreamEffects) {
      stateData.staleEffects.add(effect)
    }
  }
}

export function updateState(run: () => void) {
  if (stateData.mode !== "normal")
    throw new Error(`Can only set mode to "updating-state" when the mode is "normal", but the mode is "${stateData.mode}"`)
  stateData = {
    mode: "updating-state",
    staleDerivedSignals: new Set,
    staleEffects: new Set,
  }
  run()
  stateData = {...stateData, mode: "updating-derived-signals", derivationsBeingComputed: [], freshDerivedSignals: new Set}
  while (stateData.staleDerivedSignals.size > 0) {
    const [first] = stateData.staleDerivedSignals
    updateDerivedSignal(first)
  }
  if (stateData.derivationsBeingComputed.length > 0) throw new Error("Unreachable")
  const staleEffects = stateData.staleEffects
  stateData = {mode: "running-effect(s)"}
  for (const effect of staleEffects) {
    effect()
  }
  stateData = {mode: "normal"}
}

function handleDerivationLinking<T>(tracker: Tracker<T>) {
  const derivation = getDerivationBeingComputed()
  if (derivation !== undefined) {
    tracker.downstreamSignals.add(derivation)
    derivation.upstreamSignals.add(tracker)
  }
}

export function state<T>(value: T): {get value(): T, set value(newValue: T), tracker: StateTracker<T>} {
  const tracker: StateTracker<T> = {type: "state", value, downstreamSignals: new Set, downstreamEffects: new Set}
  return {
    tracker,
    get value() {
      handleDerivationLinking(tracker)
      return tracker.value
    },
    set value(newValue: T) {
      if (stateData.mode !== "updating-state") {
        throw new Error(`Can only update state when the mode is "updating-state", but the mode is "${stateData.mode}"`)
      }
      if (tracker.value !== newValue) {
        tracker.value = newValue
        for (const signal of tracker.downstreamSignals) {
          stateData.staleDerivedSignals.add(signal)
        }
        for (const effect of tracker.downstreamEffects) {
          stateData.staleEffects.add(effect)
        }
      }
    },
  }
}

function handleStaleUpstreamSignals(tracker: DerivedTracker<unknown>, handler: (tracker: DerivedTracker<unknown>) => void) {
  if (stateData.mode !== "updating-derived-signals") throw new Error("Unreachable")
  let hasStaleUpstreamSignals = false
  let handle = (tracker: DerivedTracker<unknown>) => {
    hasStaleUpstreamSignals = true
    handler(tracker)
    handle = handler
  }
  for (const signal of tracker.upstreamSignals) {
    if (signal.type === "derived") {
      if (stateData.freshDerivedSignals.has(signal)) continue
      // Must handle stale upstream signals before handling if this signal is
      // stale because handling the stale upstream signals might make this
      // signal stale
      handleStaleUpstreamSignals(signal, handle)
      if (stateData.staleDerivedSignals.has(signal)) handle(signal)
    }
  }
  if (hasStaleUpstreamSignals === false) {
    // TODO: Benchmark if this optimization actually improves performance
    stateData.freshDerivedSignals.add(tracker)
  }
}

const registry = new FinalizationRegistry((cleanup: () => void) => cleanup())

export function derive<T>(func: () => T): {get value(): T, tracker: DerivedTracker<T>} {
  const uninitialisedTracker: DerivedTracker<any> = {
    type: "derived",
    value: null,
    downstreamSignals: new Set,
    downstreamEffects: new Set,
    upstreamSignals: new Set,
    func,
  }
  if (stateData.mode === "normal")
    stateData = {mode: "creating-derived-signal", derivationsBeingComputed: [uninitialisedTracker]}
  else if (stateData.mode === "creating-derived-signal" || stateData.mode === "updating-derived-signals")
    throw new Error("Cannot create a derived signal in a derived signal")
  else
    throw new Error(`Can only create a derived signal when the mode is "normal", but the mode is "${stateData.mode}"`)
  uninitialisedTracker.value = func()
  stateData = {mode: "normal"}
  const tracker = uninitialisedTracker as DerivedTracker<T>
  const out = {
    tracker,
    get value() {
      if (stateData.mode === "updating-state") {
        throw new Error(`Cannot access the value of a derived signal when the mode is "updating-state"`)
      }
      handleDerivationLinking(tracker)
      if (stateData.mode === "updating-derived-signals") {
        handleStaleUpstreamSignals(tracker, staleSignal => updateDerivedSignal(staleSignal))
        if (stateData.staleDerivedSignals.has(tracker)) {
          updateDerivedSignal(tracker)
        }
      }
      return tracker.value
    },
  }
  registry.register(out, () => removeTrackerDependencies(tracker))
  return out
}

export function effect<In extends unknown[]>(...args: [
  ...{ [Key in keyof In]: {value: In[Key], tracker: Tracker<In[Key]>} },
  onUpdate: (...newValue: In) => void,
]) {
  if (stateData.mode !== "normal") throw new Error(`Can only create an effect when the mode is "normal", but mode is "${stateData.mode}"`)
  const onUpdate = args.pop() as (...newValue: In) => void
  const from = args as { [Key in keyof In]: {get value(): In[Key], tracker: Tracker<In[Key]>} }
  const run = () => onUpdate(...from.map(f => f.value) as In)
  run()
  for (const source of from) {
    source.tracker.downstreamEffects.add(run)
  }
}
