import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import { moveLegacyData, pathsFor, systemdUnit } from "./service.ts";

describe("pathsFor", () => {
  it("keeps the Library layout on macOS", () => {
    expect(pathsFor("darwin", "/Users/riza", {})).toEqual({
      dataDir: "/Users/riza/Library/Application Support/T3 Bridge",
      logFile: "/Users/riza/Library/Logs/T3 Bridge.log",
    });
  });

  it("follows the XDG base directories on Linux", () => {
    expect(pathsFor("linux", "/home/agent", {})).toEqual({
      dataDir: "/home/agent/.local/share/t3-bridge",
      logFile: "/home/agent/.local/state/t3-bridge/bridge.log",
    });
    expect(pathsFor("linux", "/home/agent", { XDG_DATA_HOME: "/data", XDG_STATE_HOME: "/state" })).toEqual({
      dataDir: "/data/t3-bridge",
      logFile: "/state/t3-bridge/bridge.log",
    });
  });
});

describe("systemdUnit", () => {
  const unit = systemdUnit({
    entry: "/home/agent/.local/share/t3-bridge/runtime/cli.cjs",
    path: "/usr/local/bin:/usr/bin:/bin",
    serviceLog: "/home/agent/.local/share/t3-bridge/service.log",
  });

  it("runs the copied build and starts with the user's manager", () => {
    expect(unit).toContain(
      'ExecStart=/usr/bin/env node "/home/agent/.local/share/t3-bridge/runtime/cli.cjs" run --service',
    );
    expect(unit).toContain('Environment="PATH=/usr/local/bin:/usr/bin:/bin"');
    expect(unit).toContain("WantedBy=default.target");
  });

  it("lets the updater outlive the process it replaces", () => {
    expect(unit).toContain("KillMode=process");
  });

  it("escapes quotes and specifiers", () => {
    const odd = systemdUnit({ entry: '/odd "dir"/50%/cli.cjs', path: "/bin", serviceLog: "/log/50%.log" });
    expect(odd).toContain('ExecStart=/usr/bin/env node "/odd \\"dir\\"/50%%/cli.cjs" run --service');
    expect(odd).toContain("StandardOutput=append:/log/50%%.log");
  });
});

describe("moveLegacyData", () => {
  const legacyHome = () => {
    const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3-bridge-home-"));
    const legacy = Path.join(home, "Library", "Application Support", "T3 Bridge");
    FS.mkdirSync(legacy, { recursive: true });
    FS.writeFileSync(Path.join(legacy, "config.json"), "{}");
    return home;
  };

  it("moves bots from the old Linux location", () => {
    const home = legacyHome();
    const to = pathsFor("linux", home, {}).dataDir;
    moveLegacyData("linux", home, to);
    expect(FS.existsSync(Path.join(to, "config.json"))).toBe(true);
  });

  it("leaves macOS and an existing new location alone", () => {
    const home = legacyHome();
    const to = Path.join(home, "existing");
    FS.mkdirSync(to);
    moveLegacyData("linux", home, to);
    moveLegacyData("darwin", home, Path.join(home, "other"));
    expect(FS.readdirSync(to)).toEqual([]);
    expect(FS.existsSync(Path.join(home, "other"))).toBe(false);
  });
});
