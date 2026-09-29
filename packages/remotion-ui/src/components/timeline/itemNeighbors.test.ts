import { expect, it } from 'vitest';
import { indexItemNeighbors } from './itemNeighbors';

it('finds temporal neighbors without reordering the authored item list', () => {
  const first = { id: 'first', from: 0 };
  const second = { id: 'second', from: 30 };
  const third = { id: 'third', from: 100 };
  const items = Object.freeze([third, first, second]);
  const neighbors = indexItemNeighbors(items);
  expect(neighbors.get(first.id)).toEqual({ left: null, right: second });
  expect(neighbors.get(second.id)).toEqual({ left: first, right: third });
  expect(neighbors.get(third.id)).toEqual({ left: second, right: null });
  expect(items).toEqual([third, first, second]);
});

it('retains authored order for overlapping items with the same start', () => {
  const first = { id: 'first', from: 10 };
  const second = { id: 'second', from: 10 };
  expect(indexItemNeighbors([first, second]).get(second.id)?.left).toBe(first);
  expect(indexItemNeighbors([second, first]).get(first.id)?.left).toBe(second);
  expect(indexItemNeighbors([]).size).toBe(0);
});
