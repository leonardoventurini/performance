declare module 'ejson' {
  /** Runtime EJSON codec surface consumed by the raw DDP client. */
  interface EjsonStatic {
    addType(name: string, factory: (jsonValue: unknown) => unknown): void;
    parse(serialized: string): unknown;
    stringify(value: unknown): string;
  }

  const EJSON: EjsonStatic;
  export default EJSON;
}
