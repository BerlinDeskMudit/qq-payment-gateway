import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from '../helpers/harness.js';
import { buildApp, API_VERSION } from '../../src/app.js';
import { ProcessorRegistry, SandboxProcessor } from '../../src/processors/index.js';
import type { Db } from '../../src/db/index.js';

/**
 * The published spec is generated from the same schemas that validate requests,
 * so it cannot drift from behaviour. What it *can* do is omit an invariant: a
 * mutating route added without an idempotency-key requirement, or a route
 * added without authentication. Both are silent, expensive mistakes, so they
 * are asserted here rather than left to review.
 */

type Operation = {
  operationId?: string;
  security?: unknown;
  parameters?: { name: string; required?: boolean; in: string }[];
  responses: Record<string, unknown>;
};

let doc: {
  openapi: string;
  info: { version: string };
  paths: Record<string, Record<string, Operation>>;
};
let routes: { method: string; url: string }[];

beforeAll(async () => {
  // The spec must be generatable without a database, so this deliberately
  // passes a Proxy that throws on any db access.
  const noDatabase = new Proxy({} as Db, {
    get(_t, prop) {
      throw new Error(`OpenAPI generation touched db.${String(prop)}`);
    },
  });
  const registry = new ProcessorRegistry();
  registry.register(new SandboxProcessor());

  const app = await buildApp({ db: noDatabase, registry, apiVersion: API_VERSION });
  doc = app.swagger() as never;
  routes = app
    .printRoutes({ commonPrefix: false })
    .split('\n')
    .join(' ')
    .match(/\/(?:v1\/)?[a-z_{}/:-]+/g)
    ?.map((u) => u.replace(/[:{}]/g, '')) ?? [];
  await app.close();
}, 60_000);

afterAll(() => { /* the app is closed above; nothing shared to clean up */ });

function specPath(routeUrl: string): string {
  // /v1/payment_intents/:id -> /v1/payment_intents/{id}
  return routeUrl.replace(/:([A-Za-z_]+)/g, '{$1}');
}

describe('OpenAPI document', () => {
  it('declares the API version and OpenAPI 3.1', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe(API_VERSION);
  });

  it('publishes every v1 route', () => {
    const published = Object.keys(doc.paths).sort();
    expect(published.length).toBeGreaterThanOrEqual(15);
    for (const expected of [
      '/v1/customers',
      '/v1/payment_methods',
      '/v1/payment_intents',
      '/v1/payment_intents/{id}',
      '/v1/payment_intents/{id}/confirm',
      '/v1/payment_intents/{id}/capture',
      '/v1/payment_intents/{id}/cancel',
      '/v1/charges',
      '/v1/charges/{id}',
      '/v1/charges/{id}/refunds',
      '/v1/events',
      '/v1/events/{id}',
      '/v1/balance',
      '/v1/webhook_endpoints',
      '/v1/webhook_deliveries',
    ]) {
      expect(published).toContain(expected);
    }
  });

  it('requires an idempotency key on every mutating route', () => {
    const mutating = Object.entries(doc.paths).flatMap(([p, item]) =>
      Object.entries(item)
        .filter(([method]) => ['post', 'patch', 'put', 'delete'].includes(method))
        .map(([method, op]) => `${method.toUpperCase()} ${p}`),
    ).sort();
    // Pinned so a newly added mutation shows up here and has to be justified.
    expect(mutating).toEqual([
      'POST /v1/charges/{id}/refunds',
      'POST /v1/customers',
      'POST /v1/payment_intents',
      'POST /v1/payment_intents/{id}/cancel',
      'POST /v1/payment_intents/{id}/capture',
      'POST /v1/payment_intents/{id}/confirm',
      'POST /v1/payment_methods',
      'POST /v1/webhook_endpoints',
      'POST /v1/webhook_endpoints/{id}/disable',
    ]);

    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, raw] of Object.entries(item)) {
        if (!['post', 'patch', 'put', 'delete'].includes(method)) continue;
        const headers = ((raw as Operation).parameters ?? []).filter((p) => p.in === 'header');
        const idem = headers.find((p) => p.name === 'idempotency-key');
        // A mutation without this header lets a network retry double-charge.
        expect(`${method} ${path} ${idem?.required === true}`).toBe(`${method} ${path} true`);
      }
    }
  });

  it('authenticates every route except health', () => {
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, raw] of Object.entries(item)) {
        const op = raw as Operation;
        expect(`${method} ${path} ${op.security !== undefined}`).toBe(`${method} ${path} true`);
      }
    }
    expect(doc.paths['/health']).toBeUndefined();
  });

  it('documents a structured error body for every failure response', () => {
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, raw] of Object.entries(item)) {
        const op = raw as Operation;
        for (const [status, body] of Object.entries(op.responses)) {
          if (status === 'default' || status.startsWith('2')) continue;
          const text = JSON.stringify(body);
          // Every error must carry the documented envelope, so a client can
          // parse failures with one code path instead of guessing per endpoint.
          expect(`${method} ${path} ${status} ${text.includes('error')}`).toBe(
            `${method} ${path} ${status} true`,
          );
        }
      }
    }
  });

  it('exposes the intended routes and nothing stale', () => {
    const published = Object.keys(doc.paths).sort();
    // Guards against a route being renamed in code but left in the spec.
    expect(published).not.toContain('/v1/payment_intents/{id}/charge');
    expect(published.every((p) => p.startsWith('/v1/'))).toBe(true);
  });
});

describe('spec generation', () => {
  it('does not require a database', async () => {
    const noDatabase = new Proxy({} as Db, {
      get(_t, prop) {
        throw new Error(`touched db.${String(prop)}`);
      },
    });
    const registry = new ProcessorRegistry();
    registry.register(new SandboxProcessor());
    const app = await buildApp({ db: noDatabase, registry, apiVersion: API_VERSION });
    expect(() => app.swagger()).not.toThrow();
    await app.close();
  }, 30_000);

  it('matches the committed openapi.json', async () => {
    const { readFile } = await import('node:fs/promises');
    const committed = JSON.parse(
      await readFile(new URL('../../openapi.json', import.meta.url), 'utf8'),
    ) as typeof doc;

    // The file is written with sorted keys for readable diffs, so compare
    // content per path rather than serialized order.
    const keys = Object.keys(committed.paths).sort();
    expect(keys).toEqual(Object.keys(doc.paths).sort());
    for (const key of keys) {
      expect(`${key} ${JSON.stringify(committed.paths[key])}`).toBe(
        `${key} ${JSON.stringify(doc.paths[key])}`,
      );
    }
  }, 30_000);
});