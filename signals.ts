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

enum TrackerType {
  State = 0,
  Derived = 1,
}

type StateTracker<T> = GeneralTracker<T> & {type: TrackerType.State}
type DerivedTracker<T> = GeneralTracker<T> & {type: TrackerType.Derived, upstreamSignals: Set<Tracker<unknown>>, func: () => T}
type Tracker<T> = DerivedTracker<T> | StateTracker<T>

enum Mode {
  Normal = 0,
  CreatingDerivedSignal = 1,
  RunningEffects = 2,
  UpdatingState = 3,
  UpdatingDerivedSignals = 4,
}

function modeName(m: Mode): string {
  switch (m) {
    case Mode.Normal:                 return "normal"
    case Mode.CreatingDerivedSignal:  return "creating derived signal"
    case Mode.RunningEffects:         return "running effects"
    case Mode.UpdatingState:          return "updating state"
    case Mode.UpdatingDerivedSignals: return "updating derived signals"
  }
}

type State = {
  mode: Mode.Normal
} | {
  mode: Mode.CreatingDerivedSignal
  derivationsBeingComputed: [DerivedTracker<unknown>]
} | {
  mode: Mode.RunningEffects
} | {
  mode: Mode.UpdatingState,
  staleDerivedSignals: Set<DerivedTracker<unknown>>,
  staleEffects: Set<() => void>,
} | {
  mode: Mode.UpdatingDerivedSignals,
  staleDerivedSignals: Set<DerivedTracker<unknown>>,
  staleEffects: Set<() => void>,
  freshDerivedSignals: Set<DerivedTracker<unknown>>, // Derived signals that have been updated this update cycle
  derivationsBeingComputed: DerivedTracker<unknown>[]
}

let stateData: State = {mode: Mode.Normal}

function getDerivationBeingComputed(): DerivedTracker<unknown> | undefined {
  if ((stateData.mode === Mode.CreatingDerivedSignal || stateData.mode === Mode.UpdatingDerivedSignals)
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
  if (stateData.mode !== Mode.UpdatingDerivedSignals) throw new Error("Unreachable")
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
  if (stateData.mode !== Mode.Normal)
    throw new Error(`Can only set the mode to ${modeName(Mode.UpdatingState)} when the mode is ${modeName(Mode.Normal)}, but the mode is ${modeName(stateData.mode)}`)
  stateData = {
    mode: Mode.UpdatingState,
    staleDerivedSignals: new Set,
    staleEffects: new Set,
  }
  run()
  stateData = {...stateData, mode: Mode.UpdatingDerivedSignals, derivationsBeingComputed: [], freshDerivedSignals: new Set}
  while (stateData.staleDerivedSignals.size > 0) {
    const [first] = stateData.staleDerivedSignals
    updateDerivedSignal(first)
  }
  if (stateData.derivationsBeingComputed.length > 0) throw new Error("Unreachable")
  const staleEffects = stateData.staleEffects
  stateData = {mode: Mode.RunningEffects}
  for (const effect of staleEffects) {
    effect()
  }
  stateData = {mode: Mode.Normal}
}

function handleDerivationLinking<T>(tracker: Tracker<T>) {
  const derivation = getDerivationBeingComputed()
  if (derivation !== undefined) {
    tracker.downstreamSignals.add(derivation)
    derivation.upstreamSignals.add(tracker)
  }
}

export function state<T>(value: T): {get value(): T, set value(newValue: T), tracker: StateTracker<T>} {
  const tracker: StateTracker<T> = {type: TrackerType.State, value, downstreamSignals: new Set, downstreamEffects: new Set}
  return {
    tracker,
    get value() {
      handleDerivationLinking(tracker)
      return tracker.value
    },
    set value(newValue: T) {
      if (stateData.mode !== Mode.UpdatingState) {
        throw new Error(`Can only update state when the mode is ${modeName(Mode.UpdatingState)}, but the mode is ${modeName(stateData.mode)}`)
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

function updateSignal(tracker: DerivedTracker<unknown>) {
  if (stateData.mode !== Mode.UpdatingDerivedSignals) throw new Error("Unreachable")
  // Must update stale upstream signals before updating this signal if it is
  // stale because running one of the stale upstream signals might make this
  // signal stale
  for (const signal of tracker.upstreamSignals) {
    if (signal.type === TrackerType.Derived) {
      if (stateData.freshDerivedSignals.has(signal)) continue
      updateSignal(signal)
    }
  }
  if (stateData.staleDerivedSignals.has(tracker)) updateDerivedSignal(tracker)
  stateData.freshDerivedSignals.add(tracker)
}

const registry = new FinalizationRegistry((cleanup: () => void) => cleanup())

export function derive<T>(func: () => T): {get value(): T, tracker: DerivedTracker<T>} {
  const uninitialisedTracker: DerivedTracker<any> = {
    type: TrackerType.Derived,
    value: null,
    downstreamSignals: new Set,
    downstreamEffects: new Set,
    upstreamSignals: new Set,
    func,
  }
  if (stateData.mode === Mode.Normal)
    stateData = {mode: Mode.CreatingDerivedSignal, derivationsBeingComputed: [uninitialisedTracker]}
  else if (stateData.mode === Mode.CreatingDerivedSignal || stateData.mode === Mode.UpdatingDerivedSignals)
    throw new Error("Cannot create a derived signal in a derived signal")
  else
    throw new Error(`Can only create a derived signal when the mode is ${modeName(Mode.Normal)}, but the mode is ${modeName(stateData.mode)}`)
  uninitialisedTracker.value = func()
  stateData = {mode: Mode.Normal}
  const tracker = uninitialisedTracker as DerivedTracker<T>
  const out = {
    tracker,
    get value() {
      if (stateData.mode === Mode.UpdatingState) {
        throw new Error(`Cannot access the value of a derived signal when the mode is ${modeName(Mode.UpdatingState)}`)
      }
      handleDerivationLinking(tracker)
      if (stateData.mode === Mode.UpdatingDerivedSignals) {
        updateSignal(tracker)
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
  if (stateData.mode !== Mode.Normal) throw new Error(`Can only create an effect when the mode is ${modeName(Mode.Normal)}, but mode is ${modeName(stateData.mode)}`)
  const onUpdate = args.pop() as (...newValue: In) => void
  const from = args as { [Key in keyof In]: {get value(): In[Key], tracker: Tracker<In[Key]>} }
  const run = () => onUpdate(...from.map(f => f.value) as In)
  run()
  for (const source of from) {
    source.tracker.downstreamEffects.add(run)
  }
}
