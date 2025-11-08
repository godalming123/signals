import * as t from "bun:test"
import * as bun from "bun"
import { type Signal, type Derived, state, updateState, derive, effect, arrayState, join, spread } from "./index"

t.describe("the core signals implementation", () => {
  t.it("correctly propagates state changes even when the state is mutated indirectly", () => {
    const list = state([1, 2, 3, 4])
    const sum = derive(() => list.value.reduce((a, b) => a + b))
    t.expect(sum.value).toBe(10)

    // This test is really trying to check that typescript doesn't just let you
    // do something like `list.value.push(n)`, but AFAIK, there is no way to
    // unit test something like this. The reason that `list.value.push(n)` is
    // wrong is because the state would have no idea that it has changed.
    updateState(() => list.update(v => v.push(5)))

    t.expect(list.value).toEqual([1, 2, 3, 4, 5])
    t.expect(sum.value).toBe(15)
  })
  t.it("has effects that work", () => {
    const count = state(1)
    let doubleCount = 0
    effect(count, c => doubleCount = c.value * 2)
    t.expect(doubleCount).toEqual(2)
    updateState(() => count.value += 1)
    t.expect(doubleCount).toEqual(4)
  })
  t.it("does not deadlock", () => {
    const sideValue = state(4)
    const topLayer = {a: state(1), b: state(2), c: state(3), d: state(4)}
    const multiply = (a: Signal<number>, b: Signal<number>): Derived<number> => derive(() => a.value * b.value)
    const middleLayer = {a: multiply(topLayer.a, topLayer.b), b: multiply(topLayer.c, topLayer.d)}
    const bottomLayer = derive(() => middleLayer.a.value * middleLayer.b.value + sideValue.value)
    const belowBottomLayer = derive(() => bottomLayer.value + middleLayer.a.value)
    let bottomLayerVal = 1 * 2 * 3 * 4 + 4
    t.expect(bottomLayer.value).toBe(bottomLayerVal)
    t.expect(belowBottomLayer.value).toBe(bottomLayerVal + 1 * 2)
    updateState(() => {
      sideValue.value = 5
      topLayer.a.value = 2
    })
    bottomLayerVal = 2 * 2 * 3 * 4 + 5
    t.expect(bottomLayer.value).toBe(bottomLayerVal)
    t.expect(belowBottomLayer.value).toBe(bottomLayerVal + 2 * 2)
  })
  t.it("allows a derived signal to be freed while the signal(s) from which it is derived are still being used", async () => {
    const source = state(1);
    (() => {
      const derived = derive(() => source.value * 2)
      t.expect(derived.value).toBe(2)
      t.expect(source.tracker.downstreamSignals.size).toBe(1)
    })()
    bun.gc()

    // The finalization registry does not cleanup memory when `bun.gc` is
    // called, but instead schedules the function to run later on
    t.expect(await new Promise<number>(resolve =>
      setTimeout(() => resolve(source.tracker.downstreamSignals.size), 0)
    )).toBe(0)
  })
  t.it("allows you to see if a signal has changed since the last time a derivation or an effect ran", () => {
    const a = state(2)
    const b = state(4)
    const c = derive((): [number, boolean, boolean] => [a.value * b.value, a.hasChangedSinceLastDerivationExecution, b.hasChangedSinceLastDerivationExecution])
    t.expect(c.value[0]).toBe(8)
    t.expect(c.value[1]).toBe(false)
    t.expect(c.value[2]).toBe(false)
    updateState(() => b.value = 5)
    t.expect(c.value[0]).toBe(10)
    t.expect(c.value[1]).toBe(false)
    t.expect(c.value[2]).toBe(true)
  })
  t.it("does not unnecersarily recalculate derived signals and effects", () => {
    const numberOfTimesThingsHaveRan = {
      doubled: 0,
      modulo: 0,
      doubleModulo: 0,
      doubleModuloEffect: 0,
    }
    const count = state(1)
    const doubled = derive(() => {
      numberOfTimesThingsHaveRan.doubled += 1
      return count.value * 2
    })
    const modulo = derive(() => {
      numberOfTimesThingsHaveRan.modulo += 1
      return count.value % 4
    })
    const doubleModulo = derive(() => {
      numberOfTimesThingsHaveRan.doubleModulo += 1
      return modulo.value * 2
    })
    effect(doubleModulo, _ => numberOfTimesThingsHaveRan.doubleModuloEffect += 1)
    t.expect(numberOfTimesThingsHaveRan).toEqual({doubled: 1, modulo: 1, doubleModulo: 1, doubleModuloEffect: 1})
    t.expect(count.value).toBe(1)
    t.expect(doubled.value).toBe(2)
    t.expect(modulo.value).toBe(1)
    t.expect(doubleModulo.value).toBe(2)
    updateState(() => {
      count.value += 2
      count.value += 2
    })
    t.expect(numberOfTimesThingsHaveRan).toEqual({doubled: 2, modulo: 2, doubleModulo: 1, doubleModuloEffect: 1})
    t.expect(count.value).toBe(5)
    t.expect(doubled.value).toBe(10)
    t.expect(modulo.value).toBe(1)
    t.expect(doubleModulo.value).toBe(2)
  })
  t.it("allows you to remove an effect", () => {
    const count = state(2)
    let lastCount = 0
    const countEffect = effect(count, c => lastCount = c.value)
    t.expect(lastCount).toBe(2)
    t.expect(count.tracker.downstreamEffects.size).toBe(1)
    updateState(() => count.value += 1)
    t.expect(lastCount).toBe(3)
    countEffect.remove()
    t.expect(count.tracker.downstreamEffects.size).toBe(0)
  })
})

t.describe("the array signals implementation", () => {
  t.it("does not unnecersarily recalculate derived arrays", () => {
    const array = arrayState([1, 2, 3, 4])
    let computations = 0
    const modulo = array.map(e => e % 3)
    const doubleModulo = modulo.map(e => {
      computations += 1
      return e * 2
    })
    const joined = join(-2, spread(array), spread(doubleModulo))
    t.expect(computations).toBe(4)
    t.expect(doubleModulo.value).toEqual([2, 4, 0, 2])
    t.expect(joined.value).toEqual([-2, 1, 2, 3, 4, 2, 4, 0, 2])
    updateState(() => {
      array.delete(1)
      array.append(5)
    })
    t.expect(computations).toBe(5)
    t.expect(array.value).toEqual([1, 3, 4, 5])
    t.expect(doubleModulo.value).toEqual([2, 0, 2, 4])
    t.expect(joined.value).toEqual([-2, 1, 3, 4, 5, 2, 0, 2, 4])
    updateState(() => {
      array.append(10, 11)
      array.move(4, 0)
    })
    t.expect(computations).toBe(7)
    t.expect(array.value).toEqual([10, 1, 3, 4, 5, 11])
    t.expect(doubleModulo.value).toEqual([2, 2, 0, 2, 4, 4])
    t.expect(joined.value).toEqual([-2, 10, 1, 3, 4, 5, 11, 2, 2, 0, 2, 4, 4])
  })
  t.it("does not let you mutate an array state outside of an `updateState` call", () => {
    const array = arrayState([1, 2, 3])
    let error
    try {
      array.append(5)
    } catch (e) {
      error = e
    }
    t.expect(error).toBeInstanceOf(Error)
  })
  t.it("allows a derived array to be freed while the array(s) from which it is derived are still being used", async () => {
    const source = arrayState([1, 2, 3]);
    (() => {
      const derived = source.map(v => v % 2)
      t.expect(derived.value).toEqual([1, 0, 1])
      t.expect(source.changes.tracker.downstreamSignals.size).toBe(1)
    })()
    bun.gc()

    // The finalization registry does not cleanup memory when `bun.gc` is
    // called, but instead schedules the function to run later on
    t.expect(await new Promise<number>(resolve =>
      setTimeout(() => resolve(source.changes.tracker.downstreamSignals.size), 0)
    )).toBe(0)
  })
})
