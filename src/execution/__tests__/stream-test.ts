import { describe, it } from 'mocha';

import { invariant } from '../../jsutils/invariant';
import { isAsyncIterable } from '../../jsutils/isAsyncIterable';
import { parse } from '../../language/parser';

import { GraphQLID, GraphQLString } from '../../type/scalars';
import { GraphQLSchema } from '../../type/schema';
import {
  GraphQLObjectType,
  GraphQLList,
  GraphQLNonNull,
} from '../../type/definition';

import { execute } from '../execute';

import type { DocumentNode } from '../../language/ast';
import { expectJSON } from '../../__testUtils__/expectJSON';

const friendType = new GraphQLObjectType({
  fields: {
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    asyncName: {
      type: GraphQLString,
      async resolve(rootValue) {
        // wait for parent stream to close
        await new Promise((r) => setTimeout(r, 2));
        return Promise.resolve(rootValue.name);
      },
    },
  },
  name: 'Friend',
});

const friends = [
  { name: 'Luke', id: 1 },
  { name: 'Han', id: 2 },
  { name: 'Leia', id: 3 },
];

const query = new GraphQLObjectType({
  fields: {
    scalarList: {
      type: new GraphQLList(GraphQLString),
      resolve: () => ['apple', 'banana', 'coconut'],
    },
    asyncList: {
      type: new GraphQLList(friendType),
      resolve: () => friends.map((f) => Promise.resolve(f)),
    },
    asyncSlowList: {
      type: new GraphQLList(friendType),
      resolve: () =>
        friends.map(async (f, i) => {
          if (i === 0) {
            await new Promise((r) => setTimeout(r, 5));
          }
          return f;
        }),
    },
    nonNullError: {
      type: new GraphQLList(new GraphQLNonNull(friendType)),
      resolve: () => [friends[0], null],
    },
    asyncListError: {
      type: new GraphQLList(friendType),
      resolve: () =>
        friends.map((f, i) => {
          if (i === 1) {
            return Promise.reject(new Error('bad'));
          }
          return Promise.resolve(f);
        }),
    },
    asyncIterableList: {
      type: new GraphQLList(friendType),
      async *resolve() {
        yield await Promise.resolve(friends[0]);
        yield await Promise.resolve(friends[1]);
        yield await Promise.resolve(friends[2]);
      },
    },
    asyncIterableError: {
      type: new GraphQLList(friendType),
      async *resolve() {
        yield await Promise.resolve(friends[0]);
        throw new Error('bad');
      },
    },
    asyncIterableNonNullError: {
      type: new GraphQLList(new GraphQLNonNull(friendType)),
      async *resolve() {
        yield await Promise.resolve(friends[0]);
        yield await Promise.resolve(null);
      },
    },
    asyncIterableInvalid: {
      type: new GraphQLList(GraphQLString),
      async *resolve() {
        yield await Promise.resolve(friends[0].name);
        yield await Promise.resolve({});
      },
    },
    asyncIterableListDelayed: {
      type: new GraphQLList(friendType),
      async *resolve() {
        for (const friend of friends) {
          // pause an additional ms before yielding to allow time
          // for tests to return or throw before next value is processed.
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 1));
          yield friend;
        }
      },
    },
    asyncIterableListNoReturn: {
      type: new GraphQLList(friendType),
      resolve() {
        let i = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            async next() {
              const friend = friends[i++];
              if (friend) {
                await new Promise((r) => setTimeout(r, 1));
                return { value: friend, done: false };
              }
              return { value: undefined, done: true };
            },
          }),
        };
      },
    },
    asyncIterableListDelayedClose: {
      type: new GraphQLList(friendType),
      async *resolve() {
        for (const friend of friends) {
          yield friend;
        }
        await new Promise((r) => setTimeout(r, 1));
      },
    },
    nestedObject: {
      type: new GraphQLObjectType({
        name: 'NestedObject',
        fields: {
          slowField: {
            type: GraphQLString,
            resolve: async () => {
              await new Promise((resolve) => setTimeout(resolve, 5));
              return 'slow';
            },
          },
          asyncIterableList: {
            type: new GraphQLList(friendType),
            async *resolve() {
              yield await Promise.resolve(friends[0]);
              yield await Promise.resolve(friends[1]);
              yield await Promise.resolve(friends[2]);
            },
          },
        },
      }),
      resolve: () => ({}),
    },
  },
  name: 'Query',
});

async function complete(
  document: DocumentNode,
  rootValue: unknown = {},
  opts?: { enableDeferStream?: boolean },
) {
  const enableDeferStream = opts?.enableDeferStream ?? true;
  const schema = new GraphQLSchema({ query, enableDeferStream });
  const result = await execute({ schema, document, rootValue });

  if (isAsyncIterable(result)) {
    const results = [];
    for await (const patch of result) {
      results.push(patch);
    }
    return results;
  }
  return result;
}

async function completeAsync(document: DocumentNode, numCalls: number) {
  const schema = new GraphQLSchema({ query, enableDeferStream: true });

  const result = await execute({ schema, document, rootValue: {} });

  invariant(isAsyncIterable(result));

  const iterator = result[Symbol.asyncIterator]();

  const promises = [];
  for (let i = 0; i < numCalls; i++) {
    promises.push(iterator.next());
  }
  return Promise.all(promises);
}

describe('Execute: stream directive', () => {
  it('Should ignore @stream if not enabled', async () => {
    const document = parse('{ scalarList @stream(initialCount: 1) }');
    const result = await complete(document, {}, { enableDeferStream: false });

    expectJSON(result).toDeepEqual({
      data: {
        scalarList: ['apple', 'banana', 'coconut'],
      },
    });
  });

  it('Can stream a list field', async () => {
    const document = parse('{ scalarList @stream(initialCount: 1) }');
    const result = await complete(document);

    expectJSON(result).toDeepEqual([
      {
        data: {
          scalarList: ['apple'],
        },
        hasNext: true,
      },
      {
        data: 'banana',
        path: ['scalarList', 1],
        hasNext: true,
      },
      {
        data: 'coconut',
        path: ['scalarList', 2],
        hasNext: false,
      },
    ]);
  });
  it('Can use default value of initialCount', async () => {
    const document = parse('{ scalarList @stream }');
    const result = await complete(document);

    expectJSON(result).toDeepEqual([
      {
        data: {
          scalarList: [],
        },
        hasNext: true,
      },
      {
        data: 'apple',
        path: ['scalarList', 0],
        hasNext: true,
      },
      {
        data: 'banana',
        path: ['scalarList', 1],
        hasNext: true,
      },
      {
        data: 'coconut',
        path: ['scalarList', 2],
        hasNext: false,
      },
    ]);
  });
  it('Negative values of initialCount are treated as 0', async () => {
    const document = parse('{ scalarList @stream(initialCount: -2) }');
    const result = await complete(document);

    expectJSON(result).toDeepEqual([
      {
        data: {
          scalarList: [],
        },
        hasNext: true,
      },
      {
        data: 'apple',
        path: ['scalarList', 0],
        hasNext: true,
      },
      {
        data: 'banana',
        path: ['scalarList', 1],
        hasNext: true,
      },
      {
        data: 'coconut',
        path: ['scalarList', 2],
        hasNext: false,
      },
    ]);
  });
  it('Returns label from stream directive', async () => {
    const document = parse(
      '{ scalarList @stream(initialCount: 1, label: "scalar-stream") }',
    );
    const result = await complete(document);

    expectJSON(result).toDeepEqual([
      {
        data: {
          scalarList: ['apple'],
        },
        hasNext: true,
      },
      {
        data: 'banana',
        path: ['scalarList', 1],
        label: 'scalar-stream',
        hasNext: true,
      },
      {
        data: 'coconut',
        path: ['scalarList', 2],
        label: 'scalar-stream',
        hasNext: false,
      },
    ]);
  });
  it('Can disable @stream using if argument', async () => {
    const document = parse(
      '{ scalarList @stream(initialCount: 0, if: false) }',
    );
    const result = await complete(document);

    expectJSON(result).toDeepEqual({
      data: { scalarList: ['apple', 'banana', 'coconut'] },
    });
  });
  it('Can stream a field that returns a list of promises', async () => {
    const document = parse(`
      query { 
        asyncList @stream(initialCount: 2) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncList: [
            {
              name: 'Luke',
              id: '1',
            },
            {
              name: 'Han',
              id: '2',
            },
          ],
        },
        hasNext: true,
      },
      {
        data: {
          name: 'Leia',
          id: '3',
        },
        path: ['asyncList', 2],
        hasNext: false,
      },
    ]);
  });
  it('Can stream in correct order with lists of promises', async () => {
    const document = parse(`
      query { 
        asyncSlowList @stream(initialCount: 0) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncSlowList: [],
        },
        hasNext: true,
      },
      {
        data: {
          name: 'Luke',
          id: '1',
        },
        path: ['asyncSlowList', 0],
        hasNext: true,
      },
      {
        data: {
          name: 'Han',
          id: '2',
        },
        path: ['asyncSlowList', 1],
        hasNext: true,
      },
      {
        data: {
          name: 'Leia',
          id: '3',
        },
        path: ['asyncSlowList', 2],
        hasNext: false,
      },
    ]);
  });
  it('Handles rejections in a field that returns a list of promises before initialCount is reached', async () => {
    const document = parse(`
      query { 
        asyncListError @stream(initialCount: 2) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        errors: [
          {
            message: 'bad',
            locations: [
              {
                line: 3,
                column: 9,
              },
            ],
            path: ['asyncListError', 1],
          },
        ],
        data: {
          asyncListError: [
            {
              name: 'Luke',
              id: '1',
            },
            null,
          ],
        },
        hasNext: true,
      },
      {
        data: {
          name: 'Leia',
          id: '3',
        },
        path: ['asyncListError', 2],
        hasNext: false,
      },
    ]);
  });
  it('Handles rejections in a field that returns a list of promises after initialCount is reached', async () => {
    const document = parse(`
      query { 
        asyncListError @stream(initialCount: 1) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncListError: [
            {
              name: 'Luke',
              id: '1',
            },
          ],
        },
        hasNext: true,
      },
      {
        data: null,
        path: ['asyncListError', 1],
        errors: [
          {
            message: 'bad',
            locations: [
              {
                line: 3,
                column: 9,
              },
            ],
            path: ['asyncListError', 1],
          },
        ],
        hasNext: true,
      },
      {
        data: {
          name: 'Leia',
          id: '3',
        },
        path: ['asyncListError', 2],
        hasNext: false,
      },
    ]);
  });
  it('Can stream a field that returns an async iterable', async () => {
    const document = parse(`
      query { 
        asyncIterableList @stream {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableList: [],
        },
        hasNext: true,
      },
      {
        data: {
          name: 'Luke',
          id: '1',
        },
        path: ['asyncIterableList', 0],
        hasNext: true,
      },
      {
        data: {
          name: 'Han',
          id: '2',
        },
        path: ['asyncIterableList', 1],
        hasNext: true,
      },
      {
        data: {
          name: 'Leia',
          id: '3',
        },
        path: ['asyncIterableList', 2],
        hasNext: true,
      },
      {
        hasNext: false,
      },
    ]);
  });
  it('Can stream a field that returns an async iterable, using a non-zero initialCount', async () => {
    const document = parse(`
      query { 
        asyncIterableList @stream(initialCount: 2) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableList: [
            {
              name: 'Luke',
              id: '1',
            },
            {
              name: 'Han',
              id: '2',
            },
          ],
        },
        hasNext: true,
      },
      {
        data: {
          name: 'Leia',
          id: '3',
        },
        path: ['asyncIterableList', 2],
        hasNext: true,
      },
      {
        hasNext: false,
      },
    ]);
  });
  it('Can stream a field that returns an async iterable, using a negative initialCount', async () => {
    const document = parse(`
      query { 
        asyncIterableList @stream(initialCount: -2) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableList: [],
        },
        hasNext: true,
      },
      {
        data: {
          name: 'Luke',
          id: '1',
        },
        path: ['asyncIterableList', 0],
        hasNext: true,
      },
      {
        data: {
          name: 'Han',
          id: '2',
        },
        path: ['asyncIterableList', 1],
        hasNext: true,
      },
      {
        data: {
          name: 'Leia',
          id: '3',
        },
        path: ['asyncIterableList', 2],
        hasNext: true,
      },
      {
        hasNext: false,
      },
    ]);
  });
  it('Can handle concurrent calls to .next() without waiting', async () => {
    const document = parse(`
      query { 
        asyncIterableList @stream(initialCount: 2) {
          name
          id
        }
      }
    `);
    const result = await completeAsync(document, 4);
    expectJSON(result).toDeepEqual([
      {
        done: false,
        value: {
          data: {
            asyncIterableList: [
              {
                name: 'Luke',
                id: '1',
              },
              {
                name: 'Han',
                id: '2',
              },
            ],
          },
          hasNext: true,
        },
      },
      {
        done: false,
        value: {
          data: {
            name: 'Leia',
            id: '3',
          },
          path: ['asyncIterableList', 2],
          hasNext: true,
        },
      },
      {
        done: false,
        value: {
          hasNext: false,
        },
      },
      {
        done: true,
        value: undefined,
      },
    ]);
  });
  it('Handles error thrown in async iterable before initialCount is reached', async () => {
    const document = parse(`
      query { 
        asyncIterableError @stream(initialCount: 2) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual({
      errors: [
        {
          message: 'bad',
          locations: [
            {
              line: 3,
              column: 9,
            },
          ],
          path: ['asyncIterableError', 1],
        },
      ],
      data: {
        asyncIterableError: [
          {
            name: 'Luke',
            id: '1',
          },
          null,
        ],
      },
    });
  });
  it('Handles error thrown in async iterable after initialCount is reached', async () => {
    const document = parse(`
      query { 
        asyncIterableError @stream(initialCount: 1) {
          name
          id
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableError: [
            {
              name: 'Luke',
              id: '1',
            },
          ],
        },
        hasNext: true,
      },
      {
        data: null,
        path: ['asyncIterableError', 1],
        errors: [
          {
            message: 'bad',
            locations: [
              {
                line: 3,
                column: 9,
              },
            ],
            path: ['asyncIterableError', 1],
          },
        ],
        hasNext: false,
      },
    ]);
  });

  it('Handles null returned in non-null list items after initialCount is reached', async () => {
    const document = parse(`
      query { 
        nonNullError @stream(initialCount: 1) {
          name
        }
      }
    `);
    const result = await complete(document);

    expectJSON(result).toDeepEqual([
      {
        data: {
          nonNullError: [
            {
              name: 'Luke',
            },
          ],
        },
        hasNext: true,
      },
      {
        data: null,
        path: ['nonNullError', 1],
        errors: [
          {
            message:
              'Cannot return null for non-nullable field Query.nonNullError.',
            locations: [
              {
                line: 3,
                column: 9,
              },
            ],
            path: ['nonNullError', 1],
          },
        ],
        hasNext: false,
      },
    ]);
  });

  it('Handles null returned in non-null async iterable list items after initialCount is reached', async () => {
    const document = parse(`
      query { 
        asyncIterableNonNullError @stream(initialCount: 1) {
          name
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableNonNullError: [
            {
              name: 'Luke',
            },
          ],
        },
        hasNext: true,
      },
      {
        data: null,
        path: ['asyncIterableNonNullError', 1],
        errors: [
          {
            message:
              'Cannot return null for non-nullable field Query.asyncIterableNonNullError.',
            locations: [
              {
                line: 3,
                column: 9,
              },
            ],
            path: ['asyncIterableNonNullError', 1],
          },
        ],
        hasNext: false,
      },
    ]);
  });
  it('Handles errors thrown by completeValue after initialCount is reached', async () => {
    const document = parse(`
      query { 
        asyncIterableInvalid @stream(initialCount: 1)
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableInvalid: ['Luke'],
        },
        hasNext: true,
      },
      {
        data: null,
        path: ['asyncIterableInvalid', 1],
        errors: [
          {
            message: 'String cannot represent value: {}',
            locations: [
              {
                line: 3,
                column: 9,
              },
            ],
            path: ['asyncIterableInvalid', 1],
          },
        ],
        hasNext: true,
      },
      {
        hasNext: false,
      },
    ]);
  });

  it('Handles promises returned by completeValue after initialCount is reached', async () => {
    const document = parse(`
      query { 
        asyncIterableList @stream(initialCount: 1) {
          name
          asyncName
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableList: [
            {
              name: 'Luke',
              asyncName: 'Luke',
            },
          ],
        },
        hasNext: true,
      },
      {
        data: {
          name: 'Han',
          asyncName: 'Han',
        },
        path: ['asyncIterableList', 1],
        hasNext: true,
      },
      {
        data: {
          name: 'Leia',
          asyncName: 'Leia',
        },
        path: ['asyncIterableList', 2],
        hasNext: true,
      },
      {
        hasNext: false,
      },
    ]);
  });
  it('Returns payloads in correct order when parent deferred fragment resolves slower than stream', async () => {
    const document = parse(`
      query { 
        nestedObject {
          ... DeferFragment @defer
        }
      }
      fragment DeferFragment on NestedObject {
        slowField
        asyncIterableList @stream(initialCount: 0) {
          name
        }
      }
    `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          nestedObject: {},
        },
        hasNext: true,
      },
      {
        data: {
          slowField: 'slow',
          asyncIterableList: [],
        },
        path: ['nestedObject'],
        hasNext: true,
      },
      {
        data: { name: 'Luke' },
        path: ['nestedObject', 'asyncIterableList', 0],
        hasNext: true,
      },
      {
        data: { name: 'Han' },
        path: ['nestedObject', 'asyncIterableList', 1],
        hasNext: true,
      },
      {
        data: { name: 'Leia' },
        path: ['nestedObject', 'asyncIterableList', 2],
        hasNext: true,
      },
      {
        hasNext: false,
      },
    ]);
  });
  it('Can @defer fields that are resolved after async iterable is complete', async () => {
    const document = parse(`
    query { 
      asyncIterableList @stream(initialCount: 1, label:"stream-label") {
        ...NameFragment @defer(label: "DeferName") @defer(label: "DeferName")
        id
      }
    }
    fragment NameFragment on Friend {
      asyncName
    }
  `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableList: [
            {
              id: '1',
            },
          ],
        },
        hasNext: true,
      },
      {
        data: {
          id: '2',
        },
        path: ['asyncIterableList', 1],
        label: 'stream-label',
        hasNext: true,
      },
      {
        data: {
          id: '3',
        },
        path: ['asyncIterableList', 2],
        label: 'stream-label',
        hasNext: true,
      },
      {
        data: {
          asyncName: 'Luke',
        },
        path: ['asyncIterableList', 0],
        label: 'DeferName',
        hasNext: true,
      },
      {
        data: {
          asyncName: 'Han',
        },
        path: ['asyncIterableList', 1],
        label: 'DeferName',
        hasNext: true,
      },
      {
        data: {
          asyncName: 'Leia',
        },
        path: ['asyncIterableList', 2],
        label: 'DeferName',
        hasNext: false,
      },
    ]);
  });
  it('Can @defer fields that are resolved before async iterable is complete', async () => {
    const document = parse(`
    query { 
      asyncIterableListDelayedClose @stream(initialCount: 1, label:"stream-label") {
        ...NameFragment @defer(label: "DeferName") @defer(label: "DeferName")
        id
      }
    }
    fragment NameFragment on Friend {
      name
    }
  `);
    const result = await complete(document);
    expectJSON(result).toDeepEqual([
      {
        data: {
          asyncIterableListDelayedClose: [
            {
              id: '1',
            },
          ],
        },
        hasNext: true,
      },
      {
        data: {
          name: 'Luke',
        },
        path: ['asyncIterableListDelayedClose', 0],
        label: 'DeferName',
        hasNext: true,
      },
      {
        data: {
          id: '2',
        },
        path: ['asyncIterableListDelayedClose', 1],
        label: 'stream-label',
        hasNext: true,
      },
      {
        data: {
          name: 'Han',
        },
        path: ['asyncIterableListDelayedClose', 1],
        label: 'DeferName',
        hasNext: true,
      },
      {
        data: {
          id: '3',
        },
        path: ['asyncIterableListDelayedClose', 2],
        label: 'stream-label',
        hasNext: true,
      },
      {
        data: {
          name: 'Leia',
        },
        path: ['asyncIterableListDelayedClose', 2],
        label: 'DeferName',
        hasNext: true,
      },
      {
        hasNext: false,
      },
    ]);
  });
  it('Returns underlying async iterables when dispatcher is returned', async () => {
    const document = parse(`
      query { 
        asyncIterableListDelayed @stream(initialCount: 1) {
          name
          id
        }
      }
    `);
    const schema = new GraphQLSchema({ query, enableDeferStream: true });

    const executeResult = await execute({ schema, document, rootValue: {} });
    invariant(isAsyncIterable(executeResult));
    const iterator = executeResult[Symbol.asyncIterator]();

    const result1 = await iterator.next();
    expectJSON(result1).toDeepEqual({
      done: false,
      value: {
        data: {
          asyncIterableListDelayed: [
            {
              id: '1',
              name: 'Luke',
            },
          ],
        },
        hasNext: true,
      },
    });

    const returnPromise = iterator.return();

    // this result had started processing before return was called
    const result2 = await iterator.next();
    expectJSON(result2).toDeepEqual({
      done: false,
      value: {
        data: {
          id: '2',
          name: 'Han',
        },
        hasNext: true,
        path: ['asyncIterableListDelayed', 1],
      },
    });

    // third result is not returned because async iterator has returned
    const result3 = await iterator.next();
    expectJSON(result3).toDeepEqual({
      done: false,
      value: {
        hasNext: false,
      },
    });
    await returnPromise;
  });
  it('Can return async iterable when underlying iterable does not have a return method', async () => {
    const document = parse(`
      query { 
        asyncIterableListNoReturn @stream(initialCount: 1) {
          name
          id
        }
      }
    `);
    const schema = new GraphQLSchema({ query, enableDeferStream: true });

    const executeResult = await execute({ schema, document, rootValue: {} });
    invariant(isAsyncIterable(executeResult));
    const iterator = executeResult[Symbol.asyncIterator]();

    const result1 = await iterator.next();
    expectJSON(result1).toDeepEqual({
      done: false,
      value: {
        data: {
          asyncIterableListNoReturn: [
            {
              id: '1',
              name: 'Luke',
            },
          ],
        },
        hasNext: true,
      },
    });

    const returnPromise = iterator.return();

    // this result had started processing before return was called
    const result2 = await iterator.next();
    expectJSON(result2).toDeepEqual({
      done: false,
      value: {
        data: {
          id: '2',
          name: 'Han',
        },
        hasNext: true,
        path: ['asyncIterableListNoReturn', 1],
      },
    });

    // third result is not returned because async iterator has returned
    const result3 = await iterator.next();
    expectJSON(result3).toDeepEqual({
      done: false,
      value: {
        hasNext: false,
      },
    });
    await returnPromise;
  });
  it('Returns underlying async iterables when dispatcher is thrown', async () => {
    const document = parse(`
      query { 
        asyncIterableListDelayed @stream(initialCount: 1) {
          name
          id
        }
      }
    `);
    const schema = new GraphQLSchema({ query, enableDeferStream: true });

    const executeResult = await execute({ schema, document, rootValue: {} });
    invariant(isAsyncIterable(executeResult));
    const iterator = executeResult[Symbol.asyncIterator]();

    const result1 = await iterator.next();
    expectJSON(result1).toDeepEqual({
      done: false,
      value: {
        data: {
          asyncIterableListDelayed: [
            {
              id: '1',
              name: 'Luke',
            },
          ],
        },
        hasNext: true,
      },
    });

    const throwPromise = iterator.throw(new Error('bad'));

    // this result had started processing before return was called
    const result2 = await iterator.next();
    expectJSON(result2).toDeepEqual({
      done: false,
      value: {
        data: {
          id: '2',
          name: 'Han',
        },
        hasNext: true,
        path: ['asyncIterableListDelayed', 1],
      },
    });

    // third result is not returned because async iterator has returned
    const result3 = await iterator.next();
    expectJSON(result3).toDeepEqual({
      done: false,
      value: {
        hasNext: false,
      },
    });
    try {
      await throwPromise;
    } catch (e) {
      // ignore error
    }
  });
});
