module.exports = {
  preset: 'ts-jest/presets/js-with-babel', // Use the TypeScript preset with Babel
  testEnvironment: 'jsdom', // Use jsdom as the test environment (for browser-like behavior)
  setupFiles: ['<rootDir>/jest.setup.js'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.after-env.js'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  testMatch: [
    '**/__tests__/**/*.test.(ts|tsx|js|jsx)',
    '**/*.test.ts',
    '**/*.test.tsx'
  ],
  transform: {
    // tsconfig.json sets jsx:"preserve" so Next's own SWC build handles
    // JSX -- ts-jest respects that setting too, which means it never
    // lowers JSX to React.createElement()/jsx() calls, leaving raw JSX in
    // its output for Node to choke on. Override just for the test
    // transform, without touching the real tsconfig.
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: { jsx: 'react-jsx' } }]
  },
  testPathIgnorePatterns: ['/node_modules/', 'auth.spec.ts'],
  moduleNameMapper: {
    '^@/public/(.*)$': '<rootDir>/public/$1',
    '^@/api/(.*)$': '<rootDir>/pages/api/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^uuid$': require.resolve('uuid'),
    // Same reason as the uuid mapping above: jsdom's testEnvironment makes
    // Jest's resolver prefer this package's ESM build (import-only syntax),
    // which then fails to parse since node_modules isn't transformed.
    // Forcing the CJS entry (resolved by plain Node here, in the config
    // file itself, so it correctly follows the "require" export condition)
    // sidesteps that. First hit via FlexBox -> Shared.tsx -> date.ts ->
    // mock.ts -> @faker-js/faker, none of which any test imported before.
    '^@faker-js/faker$': require.resolve('@faker-js/faker')
  },
  moduleDirectories: ['node_modules', 'src']
};
