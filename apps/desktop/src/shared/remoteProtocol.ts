/**
 * Re-exports the wire protocol from `@runova/protocol`, the package that
 * holds it. Keeping this thin re-export
 * (rather than importing `@runova/protocol` directly everywhere) preserves
 * the existing `@shared/remoteProtocol` import path used throughout main and
 * renderer code.
 */
export * from '@runova/protocol';
