declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "*.pem" {
  const contents: string;
  export default contents;
}
