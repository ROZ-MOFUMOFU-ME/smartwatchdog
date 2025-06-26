import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // カバレッジレポートの設定
  coverageReporters: ['text', 'lcov', 'html'],
  // カバレッジから除外するファイル
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/coverage/',
    '.*\\.d\\.ts$'
  ],
  // テストタイムアウト設定
  testTimeout: 10000,
  // モックの自動リセット
  clearMocks: true,
  // モジュールの自動リセット
  resetModules: true,
  // 詳細な出力
  verbose: true,
};

export default config; 