import { type State, type Signal, type Immutable, derive, state, stateData, Mode, modeName, isSignal } from "./core"

export const implementsImmutableArray = {}

export interface ImmutableArray<T> {
  readonly implementedInterface: typeof implementsImmutableArray,
  value: Immutable<T[]>,
  changes: Signal<Changes<T>>,
  map<Out>(func: (elem: Immutable<T> /* TODO: add an index argument */) => Immutable<Out>): DerivedArray<Out>,
}

export function isImmutableArray(value: unknown): value is ImmutableArray<unknown> {
  return value !== null && value !== undefined && (value as ImmutableArray<unknown>).implementedInterface === implementsImmutableArray
}

export interface MutableArray<T> extends ImmutableArray<T> {
  insertAt(index: number, ...values: Immutable<T[]>): void
  insert(...values: Immutable<T[]>): void
  append(...values: Immutable<T[]>): void
  delete(startIndex: number, endIndex?: number): void
  update(index: number, func: (elem: T) => void): void
  replace(index: number, newValue: Immutable<T>): void
  move(oldIndex: number, newIndex: number): void
}

export enum ChangeType {
  Insert, Delete, Move, Replace
}

export type Change<T> =
  {type: ChangeType.Insert, index: number, values: Immutable<T[]>} // Changes the index of elements after the inserted element(s)
  | {type: ChangeType.Delete, startIndex: number, length: number} // Changes the index of elements after the deleted element(s)
  | {type: ChangeType.Move, oldIndex: number, newIndex: number} // Changes the index of elements between the old position and the new position
  | {type: ChangeType.Replace, index: number, newValue: Immutable<T>}

export type Changes<T> = {
  changes: Change<T>[],
  newLength: number,
}

// Any `Immutable` that you pass into this class may be mutated internally, but is marked as `Immutable` because it should not be mutated externally
export class ArrayStateClass<T> implements MutableArray<T> {
  readonly implementedInterface = implementsImmutableArray
  public value: Immutable<T[]>
  public changes: State<Changes<T>>
  constructor(value: T[]) {
    this.value = value
    this.changes = state({changes: [], newLength: this.value.length})
  }
  insertAt(index: number, ...values: Immutable<T[]>): void {
    if (index < 0 || index > this.value.length)
      throw new Error(`index ${index} is out of its range between 0 and ${this.value.length} inclusive`)
    if (this.changes.hasChangedWhileUpdatingState === false)
      this.changes.value = {changes: [], newLength: this.value.length}
    this.changes.update(c => {
      c.newLength += values.length
      c.changes.push({type: ChangeType.Insert, index, values})
    });
    (this.value as Immutable<T>[]).splice(index, 0, ...values)
  }
  append(...values: Immutable<T[]>): void {
    this.insertAt(this.value.length, ...values)
  }
  insert(...values: Immutable<T[]>): void {
    this.insertAt(0, ...values)
  }
  delete(startIndex: number, endIndex?: number): void {
    if (startIndex < 0)
      throw new Error(`start index ${startIndex} is below 0`)
    if (endIndex === undefined)
      endIndex = startIndex
    if (endIndex < startIndex || endIndex > this.value.length-1)
      throw new Error(`end index ${endIndex} is out of its range between ${startIndex} and ${this.value.length-1} inclusive`)
    if (this.changes.hasChangedWhileUpdatingState === false)
      this.changes.value = {changes: [], newLength: this.value.length}
    const length = endIndex-startIndex+1
    this.changes.update(val => {
      val.newLength -= length
      val.changes.push({type: ChangeType.Delete, startIndex, length})
    });
    (this.value as Immutable<T>[]).splice(startIndex, length)
  }
  update(index: number, func: (elem: T) => void): void {
    const elem = this.value[index]
    if (elem === undefined)
      throw new Error(`index ${index} is out of range`)
    if (this.changes.hasChangedWhileUpdatingState === false)
      this.changes.value = {changes: [], newLength: this.value.length}
    func(elem as T)
    this.changes.update(val =>
      val.changes.push({type: ChangeType.Replace, index, newValue: elem}))
  }
  replace(index: number, newValue: Immutable<T>) {
    if (this.changes.hasChangedWhileUpdatingState === false)
      this.changes.value = {changes: [], newLength: this.value.length};
    (this.value as Immutable<T>[])[index] = newValue
    this.changes.update(val => val.changes.push({type: ChangeType.Replace, index, newValue}))
  }
  move(_oldIndex: number, _newIndex: number): void {
    if (this.changes.hasChangedWhileUpdatingState === false)
      this.changes.value = {changes: [], newLength: this.value.length}
    throw new Error("TODO: Implement move")
  }
  map<Out>(func: (elem: Immutable<T>) => Out /* does not use `Immutable` because that causes typescript to incorrectly inferr the types */): DerivedArray<Out> {
    return map(this.value, this.changes, func)
  }
}

export function updateArrayFromChanges<T>(array: Immutable<T>[], changes: Changes<T>) {
  changes.changes.forEach(change => {
    switch (change.type) {
      case ChangeType.Delete:
        array.splice(change.startIndex, change.length)
        break
      case ChangeType.Insert:
        array.splice(change.index, 0, ...change.values)
        break
      case ChangeType.Move:
        throw new Error("TODO: Implement move")
      case ChangeType.Replace:
        array[change.index] = change.newValue
    }
  })
}

export function map<In, Out>(inValue: Immutable<In[]>, inChanges: Signal<Changes<In>>, func: (elem: Immutable<In>) => Immutable<Out>): DerivedArray<Out> {
  const value = inValue.map(func)
  const derivedChanges = derive(() => {
    const out = {
      changes: inChanges.value.changes.map((change): Immutable<Change<Out>> => {
        if (change.type === ChangeType.Insert)
          return {...change, values: change.values.map(func)}
        if (change.type === ChangeType.Replace)
          return {...change, newValue: func(change.newValue)}
        return change
      }),
      newLength: inChanges.value.newLength,
    }
    updateArrayFromChanges(value, out)
    return out
  })
  return {
    changes: derivedChanges,
    implementedInterface: implementsImmutableArray,
    get value(): Immutable<Out[]> {
      if (stateData.mode !== Mode.Normal)
        throw new Error([
          `Can only get the value of a derived array when the mode if ${modeName(Mode.Normal)}, but the mode is ${modeName(stateData.mode)}. This is because:`,
          "- In the callback passed to an `updateState` call the state changes that have been caused so far by the callback have not updated the value of the derived array",
          "- In a derivation, the state changes caused by the last `updateState` call have not updated the value of the derived array",
          "- In an effect, the state changes caused by the last `updateState` call may or may not have updated the value of the derived array",
        ].join("\n"))
      return value
    },
    map(func) {
      return map(value, derivedChanges, func)
    },
  }
}

export type ArrayState<T> = ArrayStateClass<T>

export function arrayState<T>(value: T[]): ArrayState<T> {
  return new ArrayStateClass(value)
}

export type DerivedArray<T> = ImmutableArray<T>

export type SpreadImmutableArray<T> = {array: ImmutableArray<T>}

export function spread<T>(array: ImmutableArray<T>): SpreadImmutableArray<T> {
  return {array}
}

export function isSpreadImmutableArray(value: unknown): value is SpreadImmutableArray<unknown> {
  return value !== null && value !== undefined && isImmutableArray((value as SpreadImmutableArray<unknown>).array)
}

export function join<T>(...parts: (
  Immutable<T>
  | SpreadImmutableArray<T>
  | Signal<T>
)[]): DerivedArray<T> {
  const value = parts.flatMap(part => {
    if (isSpreadImmutableArray(part)) {
      return part.array.value
    } else if (isSignal(part)) {
      return [part.value]
    } else {
      return [part]
    }
  })
  const derivedChanges = derive(() => {
    let index = 0
    const updates: Change<T>[] = []
    for (const part of parts) {
      if (isSpreadImmutableArray(part)) {
        const changes = part.array.changes.value
        if (part.array.changes.hasChangedSinceLastDerivationExecution) {
          for (const change of changes.changes) {
            switch (change.type) {
              case ChangeType.Insert:
                updates.push({...change, index: index + change.index})
                break
              case ChangeType.Delete:
                updates.push({...change, startIndex: index + change.startIndex})
                break
              case ChangeType.Move:
                throw new Error("TODO: Implement move")
              case ChangeType.Replace:
                updates.push({...change, index: index + change.index})
            }
          }
        }
        index += changes.newLength
      } else if (isSignal(part)) {
        const value = part.value
        if (part.hasChangedSinceLastDerivationExecution) {
          updates.push({type: ChangeType.Replace, index, newValue: value})
        }
        index += 1
      } else {
        index += 1
      }
    }
    const out = {changes: updates, newLength: index}
    updateArrayFromChanges(value, out)
    return out
  })
  return {
    changes: derivedChanges,
    implementedInterface: implementsImmutableArray,
    get value(): Immutable<T[]> {
      if (stateData.mode !== Mode.Normal)
        throw new Error([
          `Can only get the value of a joined array when the mode if ${modeName(Mode.Normal)}, but the mode is ${modeName(stateData.mode)}. This is because:`,
          "- In the callback passed to an `updateState` call the state changes that have been caused so far by the callback have not updated the value of the joined array",
          "- In a derivation, the state changes caused by the last `updateState` call have not updated the value of the joined array",
          "- In an effect, the state changes caused by the last `updateState` call may or may not have updated the value of the joined array",
        ].join("\n"))
      return value
    },
    map(func) {
      return map(value, derivedChanges, func)
    }
  }
}
