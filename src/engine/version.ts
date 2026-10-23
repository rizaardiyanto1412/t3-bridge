import pkg from "../../package.json" with { type: "json" };

export const BRIDGE_VERSION: string = pkg.version;
