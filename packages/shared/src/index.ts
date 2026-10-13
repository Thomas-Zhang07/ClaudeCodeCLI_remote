/**
 * @ccr/shared — types and the pure transcript parser.
 *
 * Nothing in this package touches the filesystem or the network; the bridge
 * supplies bytes and owns all I/O. That keeps the parsing rules unit-testable
 * against recorded fixtures.
 */

export * from './types.js';
export * from './framing.js';
export * from './parse.js';
export * from './subagents.js';
export * from './registry.js';
export * from './truncate.js';
export * from './redact.js';
