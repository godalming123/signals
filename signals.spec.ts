import * as t from "bun:test"
import * as bun from "bun"
import {state, updateState, derive, effect} from "./signals"

// These tests do not depend on implementation details
t.describe("this signals library is correct", () => {
  t.it("does not deadlock", () => {
    const topLayer = [1, 2, 3, 4].map(n => state(n))
    const middleLayer = [[0, 1], [2, 3]].map(([a, b]) => derive(() => topLayer[a].value * topLayer[b].value))
    const bottomLayer = derive(() => middleLayer[0].value * middleLayer[1].value)
    t.expect(bottomLayer.value).toBe(1 * 2 * 3 * 4)
    updateState(() => topLayer[0].value = 2)
    t.expect(bottomLayer.value).toBe(2 * 2 * 3 * 4)
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
})

// These tests may depend on implementation details
t.describe("this signals library is efficient", () => {
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
    t.expect(numberOfTimesThingsHaveRan.doubled).toBe(1)
    t.expect(numberOfTimesThingsHaveRan.modulo).toBe(1)
    t.expect(numberOfTimesThingsHaveRan.doubleModulo).toBe(1)
    t.expect(numberOfTimesThingsHaveRan.doubleModuloEffect).toBe(1)
    t.expect(count.value).toBe(1)
    t.expect(doubled.value).toBe(2)
    t.expect(modulo.value).toBe(1)
    t.expect(doubleModulo.value).toBe(2)
    updateState(() => {
      count.value += 2
      count.value += 2
    })
    t.expect(numberOfTimesThingsHaveRan.doubled).toBe(2)
    t.expect(numberOfTimesThingsHaveRan.modulo).toBe(2)
    t.expect(numberOfTimesThingsHaveRan.doubleModulo).toBe(1)
    t.expect(numberOfTimesThingsHaveRan.doubleModuloEffect).toBe(1)
    t.expect(count.value).toBe(5)
    t.expect(doubled.value).toBe(10)
    t.expect(modulo.value).toBe(1)
    t.expect(doubleModulo.value).toBe(2)
  })
})
