import { describe, expect, it } from "vitest";
import { loadConfig, loadSteelConfig, loadTextConfig } from "@/utils/config.ts";

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

  it("includes the text helper only when QAML_TEXT_MODEL is configured", () => {
    expect(loadConfig({ ...baseEnv }).text).toBeUndefined();

    const config = loadConfig({
      ...baseEnv,
      QAML_TEXT_MODEL: "gpt-4o-mini",
      OPENAI_API_KEY: "sk-1",
    });
    expect(config.text).toEqual({
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1",
    });
  });
});

describe("loadTextConfig", () => {
  it("is undefined when QAML_TEXT_MODEL is unset", () => {
    expect(loadTextConfig({})).toBeUndefined();
    expect(loadTextConfig({ QAML_TEXT_MODEL: "  " })).toBeUndefined();
    expect(loadTextConfig({ OPENAI_API_KEY: "sk-1" })).toBeUndefined();
  });

  it("defaults to the OpenAI endpoint and prefers OPENAI_API_KEY", () => {
    expect(
      loadTextConfig({
        QAML_TEXT_MODEL: "gpt-4o-mini",
        OPENAI_API_KEY: "sk-1",
        OPENROUTER_API_KEY: "or-1",
      }),
    ).toEqual({
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1",
    });
  });

  it("prefers OPENROUTER_API_KEY for an OpenRouter base URL and trims slashes", () => {
    expect(
      loadTextConfig({
        QAML_TEXT_MODEL: "openai/gpt-4o-mini",
        QAML_TEXT_MODEL_BASE_URL: "https://openrouter.ai/api/v1/",
        OPENAI_API_KEY: "sk-1",
        OPENROUTER_API_KEY: "or-1",
      }),
    ).toEqual({
      model: "openai/gpt-4o-mini",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "or-1",
    });
  });

  it("falls back to the other provider key when the preferred one is missing", () => {
    expect(
      loadTextConfig({
        QAML_TEXT_MODEL: "m",
        QAML_TEXT_MODEL_BASE_URL: "https://openrouter.ai/api/v1",
        OPENAI_API_KEY: "sk-1",
      })?.apiKey,
    ).toBe("sk-1");
  });

  it("lets an explicit QAML_TEXT_MODEL_API_KEY win", () => {
    expect(
      loadTextConfig({
        QAML_TEXT_MODEL: "m",
        QAML_TEXT_MODEL_API_KEY: "explicit",
        OPENAI_API_KEY: "sk-1",
        OPENROUTER_API_KEY: "or-1",
      })?.apiKey,
    ).toBe("explicit");
  });

  it("fails fast when the model is set but no key exists", () => {
    expect(() => loadTextConfig({ QAML_TEXT_MODEL: "m" })).toThrow(
      /QAML_TEXT_MODEL_API_KEY/,
    );
  });

  it("rejects an invalid QAML_TEXT_MODEL_BASE_URL", () => {
    expect(() =>
      loadTextConfig({
        QAML_TEXT_MODEL: "m",
        QAML_TEXT_MODEL_BASE_URL: "not a url",
        OPENAI_API_KEY: "sk-1",
      }),
    ).toThrow(/QAML_TEXT_MODEL_BASE_URL/);
  });
});

describe("loadSteelConfig", () => {
  it("defaults to local mode without requiring any API keys", () => {
    expect(loadSteelConfig({})).toEqual({
      baseUrl: "http://localhost:3000",
      mode: "local",
      apiKey: undefined,
    });
  });

  it("requires STEEL_API_KEY for a non-local base URL", () => {
    const env = { STEEL_BASE_URL: "https://steel.example.com" };
    expect(() => loadSteelConfig(env)).toThrow(/STEEL_API_KEY/);
    expect(loadSteelConfig({ ...env, STEEL_API_KEY: "k" }).mode).toBe("cloud");
  });
});
