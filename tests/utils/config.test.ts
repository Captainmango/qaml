import { describe, expect, it } from "vitest";
import { loadConfig } from "@/utils/config.ts";

const baseEnv = { TYPESAFE_API_KEY: "ts-key" } as const;

describe("loadConfig", () => {
  it("defaults to local mode with the local Steel URL", () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.steel).toEqual({
      baseUrl: "http://localhost:3000",
      mode: "local",
      apiKey: undefined,
    });
    expect(config.typesafe).toEqual({
      apiKey: "ts-key",
      jevModel: "jev-latest",
    });
    expect(config.runsDir).toBe("runs");
  });

  it("treats a non-local STEEL_BASE_URL as cloud mode and requires STEEL_API_KEY", () => {
    const cloudEnv = {
      ...baseEnv,
      STEEL_BASE_URL: "https://steel.example.com/",
      STEEL_API_KEY: "steel-key",
    };
    const config = loadConfig(cloudEnv);
    expect(config.steel.mode).toBe("cloud");
    expect(config.steel.baseUrl).toBe("https://steel.example.com");
    expect(config.steel.apiKey).toBe("steel-key");

    const { STEEL_API_KEY: _omitted, ...noKeyEnv } = cloudEnv;
    expect(() => loadConfig(noKeyEnv)).toThrow(/STEEL_API_KEY/);
  });

  it("fails fast when TYPESAFE_API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow(/TYPESAFE_API_KEY/);
  });

  it("rejects an invalid STEEL_BASE_URL", () => {
    expect(() =>
      loadConfig({ ...baseEnv, STEEL_BASE_URL: "not a url" }),
    ).toThrow(/STEEL_BASE_URL/);
  });

  it("honours QAML_JEV_MODEL and QAML_RUNS_DIR overrides", () => {
    const config = loadConfig({
      ...baseEnv,
      QAML_JEV_MODEL: "jev-custom",
      QAML_RUNS_DIR: "out/runs",
    });
    expect(config.typesafe.jevModel).toBe("jev-custom");
    expect(config.runsDir).toBe("out/runs");
  });
});
