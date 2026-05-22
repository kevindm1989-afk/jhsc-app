/**
 * Test sink for the structured logger.
 *
 * In test/dev environments, the logger's transport is replaced by an
 * in-process sink that captures every emitted LogLine. Tests assert
 * against the captured lines instead of mocking network calls.
 *
 * Reset between tests via `__resetCapture`; install via `__setTestSink`.
 *
 * Production code MUST NOT depend on this module's exports.
 */
import type { LogLine } from './index';

let captured: LogLine[] = [];
let sink: ((line: LogLine) => void) | null = null;

export function __setTestSink(custom?: (line: LogLine) => void): void {
  sink = (line) => {
    captured.push(line);
    if (custom) custom(line);
  };
}

export function __resetCapture(): void {
  captured = [];
}

export function __getCapturedLines(): readonly LogLine[] {
  return captured;
}

/**
 * Internal — used by the logger module to discover whether a test sink
 * is currently installed.
 */
export function getTestSink(): ((line: LogLine) => void) | null {
  return sink;
}
