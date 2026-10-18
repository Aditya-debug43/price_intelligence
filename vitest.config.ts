import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      // The live procedure sends real requests to real websites, so it never runs with the ordinary suite: `npm run test:live` (docs/verification-report.md).
      ...(process.env['LIVE_TESTS'] === '1'
        ? [
            {
              test: {
                name: 'live',
                include: ['tests/live/**/*.live.test.ts'],
                environment: 'node' as const,
                globalSetup: ['tests/support/global-setup.ts'],
                testTimeout: 900_000,
                hookTimeout: 120_000,
                fileParallelism: false,
              },
            },
          ]
        : []),
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/support/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});