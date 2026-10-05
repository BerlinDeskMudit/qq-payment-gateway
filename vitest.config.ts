import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],

    /**
     * PGlite is a WASM build of Postgres. Applying the schema takes ~2.5s on an
     * idle machine and can exceed three times that once several suites run in
     * parallel, because every worker is competing for the same cores. Vitest's
     * 5s default turned that into a flaky failure in `migrate.test.ts` that had
     * nothing to do with correctness.
     *
     * The timeouts are set from measured worst-case behaviour rather than from
     * "make it green": a test that needs 40s of Postgres work should say so in
     * its own name, and anything slower than this is a real problem.
     */
    testTimeout: 120_000,
    hookTimeout: 180_000,

    /**
     * Bounded parallelism. These suites are CPU-bound in WASM rather than I/O
     * bound, so oversubscribing cores makes every suite slower and inflates the
     * timeouts above rather than helping.
     */
    maxWorkers: 4,
    minWorkers: 1,
  },
});