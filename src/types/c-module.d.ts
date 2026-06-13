/**
 * Ambient declaration for `.c` source imported with `{ type: "file" }` (Bun's
 * `cc` FFI compiler). The import resolves to the file path as a string. Bun
 * ships type declarations for many asset extensions but not `.c`, so we add it.
 */
declare module "*.c" {
  const path: string;
  export default path;
}
