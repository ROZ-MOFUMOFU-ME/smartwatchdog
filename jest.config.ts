/** @jest-config-loader ts-node */
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  testPathIgnorePatterns: ['/dist/'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true }],
  },
};

export default config;
