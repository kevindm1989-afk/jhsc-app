/**
 * Minimal type declaration for libsodium-wrappers.
 *
 * libsodium-wrappers does not ship .d.ts files. The implementer of T07
 * may pin `@types/libsodium-wrappers` or expand the declaration here as
 * the wrapper module grows. At scaffold we only need the `ready` promise
 * to typecheck.
 */
declare module 'libsodium-wrappers' {
  const sodium: {
    ready: Promise<void>;
    [key: string]: unknown;
  };
  export default sodium;
}
