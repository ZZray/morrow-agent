// Copyright (c) Ray Zhang. Chart math: nice axis maxima, monotone curves that never overshoot, crosshair snapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { niceMax, ticks, smoothPath, nearestIndex } from '../src/admin/charts.ts';

test('axis maxima round up to readable steps', () => {
  assert.deepEqual([0, 0.4, 1, 3, 7, 12, 230, 1800].map(niceMax), [1, 0.5, 1, 5, 10, 20, 250, 2000]);
  assert.deepEqual(ticks(7), [0, 2.5, 5, 7.5, 10]);
});

test('monotone curve stays within the data range and crosshair snaps to the nearest day', () => {
  const points: [number, number][] = [[0, 100], [100, 100], [200, 0], [300, 0], [400, 50]];
  const ys = [...smoothPath(points).matchAll(/-?[0-9.]+,(-?[0-9.]+)/g)].map(m => Number(m[1]));
  assert.ok(ys.every(y => y >= -1e-9 && y <= 100 + 1e-9), '控制点不越界，曲线不会画出负值');
  assert.equal(smoothPath([[5, 5]]), 'M5,5'); assert.equal(smoothPath([]), '');
  assert.deepEqual([0, 0.1, 0.49, 0.51, 1, 1.3, -0.2].map(f => nearestIndex(f, 3)), [0, 0, 1, 1, 2, 2, 0]);
});
