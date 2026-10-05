import Fastify, { LogController, type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import type { Db } from './db/index.js';
import type { ProcessorRegistry } from './processors/index.js';
import { ApiError } from './lib/errors.js';
import { registerRoutes } from './routes/v1.js';

export type AppDeps = {
  db: Db;
  registry: ProcessorRegistry;
  apiVersion: string;
  /** Fastify log level. Omit for silent logging, as in tests. */
  logLevel?: string;
};

/**
 * Application assembly.
 *
 * Two deliberate choices:
 *   * the app is built from injected deps and never connects on import, so a
 *     test can construct it against PGlite in milliseconds
 *   * every error is mapped once, here, so handlers never shape a response
 */

export const API_VERSION = '1.0.0';

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logLevel === undefined ? false : { level: deps.logLevel },
    // One log line per request would swamp the ones that matter. This replaces
    // the top-level `disableRequestLogging`, which Fastify 5 deprecates (FSTDEP023)
    // and removes in 6.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 256 * 1024,
    ajv: { customOptions: { coerceTypes: true, removeAdditional: false, allErrors: false } },
  });

  // Registered before the routes so the `security` and `hide` fields they
  // declare become part of the OpenAPI document rather than a type error.
  // The spec is generated from the same TypeBox schemas that validate
  // requests, so the two cannot drift apart.
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'QQ Payment Gateway',
        version: deps.apiVersion,
        description:
          'Payment infrastructure as software: card payments, a double-entry ledger, ' +
          'idempotent retries and signed webhooks.',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', name: 'Authorization', in: 'header' },
        },
      },
    },
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const requestId = String(req.headers['request-id'] ?? '');
    const candidate = err as { statusCode?: number; validation?: unknown; message?: string };
    if (err instanceof ApiError) {
      if (err.status >= 500) req.log.error({ err, requestId }, 'request failed');
      return reply.code(err.status).send(err.toBody(requestId));
    }

    // Fastify's own validation error has statusCode and a code we own.
    const status = typeof candidate.statusCode === 'number' ? candidate.statusCode : 500;
    if (candidate.validation) {
      return reply.code(400).send({
        error: {
          type: 'invalid_request_error',
          code: 'parameter_invalid',
          message: `Invalid request: ${candidate.message ?? 'failed schema validation'}`,
          docs_url: 'https://docs.qqpg.io/errors/parameter-invalid',
          retryable: false,
          ...(requestId ? { request_id: requestId } : {}),
        },
      });
    }
    if (status < 500) {
      return reply.code(status).send({
        error: {
          type: 'invalid_request_error',
          code: 'invalid_request',
          message: candidate.message ?? 'Request rejected.',
          retryable: false,
          ...(requestId ? { request_id: requestId } : {}),
        },
      });
    }

    req.log.error({ err, requestId }, 'unhandled error');
    // Never leak an internal message to the client: stack traces and SQL
    // fragments are reconnaissance for an attacker.
    return reply.code(500).send({
      error: {
        type: 'api_error',
        code: 'internal_error',
        message: 'An unexpected error occurred.',
        retryable: true,
        ...(requestId ? { request_id: requestId } : {}),
      },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: {
        type: 'invalid_request_error',
        code: 'resource_missing',
        message: `No route for ${req.method} ${req.url}`,
        retryable: false,
      },
    }),
  );

  await registerRoutes(app, deps);

  await app.ready();
  return app;
}