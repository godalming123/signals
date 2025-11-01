export type Immutable<T> = {
  readonly [Key in keyof T]: Immutable<T[Key]>;
}

export type GeneralTracker<T> = {
  value: T,
  hasChanged: boolean,
  downstreamSignals: Set<DerivedTracker<unknown>>,
  downstreamEffects: Set<() => void>,
}

export enum TrackerType {
  State = 0,
  Derived = 1,
}

export type StateTracker<T> = GeneralTracker<T> & {type: TrackerType.State}
export type DerivedTracker<T> = GeneralTracker<T> & {type: TrackerType.Derived, upstreamSignals: Set<Tracker<unknown>>, func: () => T}
export type Tracker<T> = DerivedTracker<T> | StateTracker<T>

export enum Mode {
  Normal,
  UpdatingState,
  CreatingEffect, // running effect for the first time
  RunningEffects,
  CreatingDerivedSignal, // running derived signal for the first time
  UpdatingDerivedSignals,
}

export function modeName(m: Mode): string {
  switch (m) {
    case Mode.Normal:                 return "normal"
    case Mode.UpdatingState:          return "updating state"
    case Mode.CreatingEffect:         return "creating effect"
    case Mode.RunningEffects:         return "running effects"
    case Mode.CreatingDerivedSignal:  return "creating derived signal"
    case Mode.UpdatingDerivedSignals: return "updating derived signals"
  }
}

export type StateData = {
  mode: Mode.Normal
} | {
  mode: Mode.UpdatingState,
  changedSignals: Tracker<unknown>[],
  staleDerivedSignals: Set<DerivedTracker<unknown>>,
  staleEffects: Set<() => void>,
} | {
  mode: Mode.CreatingEffect
} | {
  mode: Mode.RunningEffects
  readonly changedSignals: Tracker<unknown>[]
} | {
  mode: Mode.CreatingDerivedSignal
  derivationsBeingComputed: [DerivedTracker<unknown>]
} | {
  mode: Mode.UpdatingDerivedSignals,
  changedSignals: Tracker<unknown>[],
  staleDerivedSignals: Set<DerivedTracker<unknown>>,
  staleEffects: Set<() => void>,
  freshDerivedSignals: Set<DerivedTracker<unknown>>, // Derived signals that have been updated this update cycle
  derivationsBeingComputed: DerivedTracker<unknown>[]
}

export let stateData: StateData = {mode: Mode.Normal}

export function getDerivationBeingComputed(): DerivedTracker<unknown> | undefined {
  if ((stateData.mode === Mode.CreatingDerivedSignal || stateData.mode === Mode.UpdatingDerivedSignals)
    && stateData.derivationsBeingComputed.length > 0) {
    return stateData.derivationsBeingComputed[stateData.derivationsBeingComputed.length-1]
  }
  return undefined
}

export function removeTrackerDependencies(tracker: DerivedTracker<unknown>) {
  for (const dependency of tracker.upstreamSignals) {
    const removed = dependency.downstreamSignals.delete(tracker)
    if (removed !== true) {
      throw new Error("Unreachable")
    }
  }
  tracker.upstreamSignals = new Set()
}

export function updateDerivedSignal(derivedSignal: DerivedTracker<unknown>) {
  if (stateData.mode !== Mode.UpdatingDerivedSignals) throw new Error("Unreachable")
  removeTrackerDependencies(derivedSignal)
  const oldValue = derivedSignal.value
  stateData.derivationsBeingComputed.push(derivedSignal)
  derivedSignal.value = derivedSignal.func()
  stateData.derivationsBeingComputed.pop()
  stateData.staleDerivedSignals.delete(derivedSignal)
  if (derivedSignal.value !== oldValue) {
    if (derivedSignal.hasChanged !== false) throw new Error("Unreachable")
    derivedSignal.hasChanged = true
    stateData.changedSignals.push(derivedSignal)
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
    changedSignals: [],
    staleDerivedSignals: new Set,
    staleEffects: new Set,
  }
  run()
  stateData = {...stateData, mode: Mode.UpdatingDerivedSignals, derivationsBeingComputed: [], freshDerivedSignals: new Set}
  while (true) {
    const [first] = stateData.staleDerivedSignals
    if (first === undefined) break
    updateDerivedSignal(first)
    stateData.freshDerivedSignals.add(first)
  }
  if (stateData.derivationsBeingComputed.length > 0) throw new Error("Unreachable")
  const staleEffects = stateData.staleEffects
  stateData = {mode: Mode.RunningEffects, changedSignals: stateData.changedSignals}
  for (const effect of staleEffects) {
    effect()
  }
  for (const signal of stateData.changedSignals) {
    if (signal.hasChanged !== true) throw new Error("Unreachable")
    signal.hasChanged = false
  }
  stateData = {mode: Mode.Normal}
}

export function handleDerivationLinking<T>(tracker: Tracker<T>) {
  const derivation = getDerivationBeingComputed()
  if (derivation !== undefined) {
    tracker.downstreamSignals.add(derivation)
    derivation.upstreamSignals.add(tracker)
  }
}

export const implementsSignal = {}

export type Signal<T> = {
  readonly implementedInterface: typeof implementsSignal,
  get value(): Immutable<T>,
  tracker: Tracker<T>,

  // This function returns false if the derivation is being ran for the first time
  // When a derivation calls this function, it does not get linked to the signal
  get hasChangedSinceLastDerivationExecution(): boolean,
}

export function isSignal(value: unknown): value is Signal<unknown> {
  return value !== null && value !== undefined && (value as Signal<unknown>).implementedInterface === implementsSignal
}

export type State<T> = Signal<T> & {
  set value(newValue: Immutable<T>),
  update: (callback: (reference: T) => void) => void,
  get hasChangedWhileUpdatingState(): boolean
}

// This function assumes that the consumer does not try to mutate this state by:
// - Casting a readonly from `.value` to a mutable, or;
// - Using the mutable from `.tracker.value`
// - Mutating the original mutable reference that the consumer passed in as `value`
// To mutate this state either use the `update` function or the `value` setter
export function state<T>(value: T /* does not use `Immutable` because that causes typescript to incorrectly infer the types */): State<T> {
  const tracker: StateTracker<T> = {type: TrackerType.State, value: value, hasChanged: false,  downstreamSignals: new Set, downstreamEffects: new Set}
  function handleValueChange() {
    if (stateData.mode !== Mode.UpdatingState) {
      throw new Error(`Can only update state when the mode is ${modeName(Mode.UpdatingState)}, but the mode is ${modeName(stateData.mode)}`)
    }
    if (tracker.hasChanged !== true) {
      tracker.hasChanged = true
      stateData.changedSignals.push(tracker)
      for (const signal of tracker.downstreamSignals) {
        stateData.staleDerivedSignals.add(signal)
      }
      for (const effect of tracker.downstreamEffects) {
        stateData.staleEffects.add(effect)
      }
    }
  }
  return {
    implementedInterface: implementsSignal,
    tracker,
    get value(): Immutable<T> {
      handleDerivationLinking(tracker)
      return tracker.value
    },
    set value(newValue: Immutable<T> /* may still be mutated internally */) {
      if (stateData.mode !== Mode.UpdatingState) {
        throw new Error(`Can only update state when the mode is ${modeName(Mode.UpdatingState)}, but the mode is ${modeName(stateData.mode)}`)
      }
      if (tracker.value !== newValue) {
        tracker.value = newValue as T
        handleValueChange()
      }
    },
    update: (callback: (reference: T) => void) => {
      if (stateData.mode !== Mode.UpdatingState) {
        throw new Error(`Can only update state when the mode is ${modeName(Mode.UpdatingState)}, but the mode is ${modeName(stateData.mode)}`)
      }
      callback(tracker.value)
      handleValueChange()
    },
    get hasChangedSinceLastDerivationExecution() {
      if (stateData.mode !== Mode.CreatingDerivedSignal && stateData.mode !== Mode.UpdatingDerivedSignals && stateData.mode)
        throw new Error(`Can only check if a piece of state has changed since the last derivation execution when the mode is either ${modeName(Mode.CreatingDerivedSignal)}, or ${modeName(Mode.UpdatingDerivedSignals)}, but the mode is ${modeName(stateData.mode)}`)
      return tracker.hasChanged
    },
    get hasChangedWhileUpdatingState() {
      if (stateData.mode !== Mode.UpdatingState)
        throw new Error(`Can only check if a piece of state has changed while updating the state when the mode is ${modeName(Mode.UpdatingState)}, but the mode is ${modeName(stateData.mode)}`)
      return tracker.hasChanged
    }
  }
}

export function updateSignal(tracker: DerivedTracker<unknown>) {
  if (stateData.mode !== Mode.UpdatingDerivedSignals) throw new Error("Unreachable")
  if (stateData.freshDerivedSignals.has(tracker)) return
  // Must update stale upstream signals before updating this signal if it is
  // stale because running one of the stale upstream signals might make this
  // signal stale
  for (const signal of tracker.upstreamSignals) {
    if (signal.type === TrackerType.Derived)
      updateSignal(signal)
  }
  if (stateData.staleDerivedSignals.has(tracker)) updateDerivedSignal(tracker)
  stateData.freshDerivedSignals.add(tracker)
}

export const derivationRegistry = new FinalizationRegistry((cleanup: () => void) => cleanup())

export type Derived<T> = Signal<T>

export function derive<T>(func: () => T /* does not use `Immutable` because that causes typescript to incorrectly inferr the types */): Derived<T> {
  const uninitialisedTracker: DerivedTracker<any> = {
    type: TrackerType.Derived,
    hasChanged: false,
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
  const out: Derived<T> = {
    implementedInterface: implementsSignal,
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
    get hasChangedSinceLastDerivationExecution() {
      if (stateData.mode === Mode.UpdatingDerivedSignals)
        updateSignal(tracker)
      else if (stateData.mode !== Mode.CreatingDerivedSignal)
        throw new Error(`Can only check if a derived signal has changed since the last derivation execution when the mode is either ${modeName(Mode.CreatingDerivedSignal)} or ${modeName(Mode.UpdatingDerivedSignals)}, but the mode is ${modeName(stateData.mode)}`)
      return tracker.hasChanged
    },
  }
  derivationRegistry.register(out, () => removeTrackerDependencies(tracker))
  return out
}

export function effect<In extends unknown[]>(...args: [
  ...{ [Key in keyof In]: {get value(): Immutable<In[Key]>, tracker: Tracker<In[Key]>} },
  onUpdate: (...updateInfo: {[Key in keyof In]: {
    value: Immutable<In[Key]>,
    hasChangedSinceLastEffectExecution: boolean, // This is false if the effect is being ran for the first time
  }}) => void,
]) {
  if (stateData.mode !== Mode.Normal) throw new Error(`Can only create an effect when the mode is ${modeName(Mode.Normal)}, but mode is ${modeName(stateData.mode)}`)
  const onUpdate = args.pop() as (...updateInfo: { [Key in keyof In]: {value: In[Key], hasChangedSinceLastEffectExecution: boolean}}) => void
  const from = args as { [Key in keyof In]: {get value(): Immutable<In[Key]>, tracker: Tracker<In[Key]>} }
  const run = () => onUpdate(
    ...from.map(f => {return {value: f.value, hasChanged: f.tracker.hasChanged}}) as
    { [Key in keyof In]: {value: Immutable<In[Key]>, hasChangedSinceLastEffectExecution: boolean}}
  )
  stateData = {mode: Mode.CreatingEffect}
  run()
  stateData = {mode: Mode.Normal}
  for (const source of from) {
    source.tracker.downstreamEffects.add(run)
  }
}
