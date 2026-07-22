import { describe, it, expect } from "vitest";
import { parseOpenshipConfig, parseOpenshipConfigJson } from "./parse";

describe("parseOpenshipConfig", () => {
  it("accepts a full, valid config and strips undefined fields", () => {
    const { config, errors, warnings } = parseOpenshipConfig({
      framework: "nextjs",
      packageManager: "pnpm",
      installCommand: "pnpm install",
      buildCommand: "pnpm build",
      outputDirectory: ".next",
      productionPaths: [".next", "public"],
      runtime: "docker",
      productionMode: "standalone",
      port: 3000,
      env: { PUBLIC_URL: "https://x", API_KEY: { value: "sk_1", secret: true } },
      domains: ["app.example.com", { domain: "api.example.com", port: 8080, type: "custom" }],
      routes: { cleanUrls: true, redirects: [{ source: "/old", destination: "/new", permanent: true }] },
      resources: { tier: "medium" },
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(config).toMatchObject({
      framework: "nextjs",
      runtime: "docker",
      port: 3000,
      env: { PUBLIC_URL: "https://x", API_KEY: { value: "sk_1", secret: true } },
      resources: { tier: "medium" },
    });
    // normalized domains: string → object
    expect(config?.domains?.[0]).toEqual({ domain: "app.example.com" });
    expect(config?.domains?.[1]).toMatchObject({ domain: "api.example.com", port: 8080, type: "custom" });
    // no stray undefined keys
    expect(Object.values(config as object).every((v) => v !== undefined)).toBe(true);
  });

  it("rejects an unknown framework and out-of-range port", () => {
    const { errors } = parseOpenshipConfig({ framework: "coldfusion", port: 99999 });
    expect(errors.some((e) => e.startsWith("framework:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("port:"))).toBe(true);
  });

  it("rejects a bad enum (runtime) and bad resource range", () => {
    const { errors } = parseOpenshipConfig({ runtime: "vm", resources: { cpuCores: 99 } });
    expect(errors.some((e) => e.startsWith("runtime:"))).toBe(true);
    expect(errors.some((e) => e.includes("resources.cpuCores"))).toBe(true);
  });

  it("coerces a string port and validates env value shape", () => {
    const ok = parseOpenshipConfig({ port: "8080", env: { A: "1" } });
    expect(ok.errors).toEqual([]);
    expect(ok.config?.port).toBe(8080);
    const bad = parseOpenshipConfig({ env: { A: { secret: true } } }); // missing value
    expect(bad.errors.some((e) => e.includes("env.A.value"))).toBe(true);
  });

  it("validates a service and requires its name", () => {
    const ok = parseOpenshipConfig({
      services: [{ name: "db", image: "postgres:17", ports: ["5432"], restart: "unless-stopped" }],
    });
    expect(ok.errors).toEqual([]);
    expect(ok.config?.services?.[0]).toMatchObject({ name: "db", restart: "unless-stopped" });
    const noName = parseOpenshipConfig({ services: [{ image: "x" }] });
    expect(noName.errors.some((e) => e.includes("requires a `name`"))).toBe(true);
    const badRestart = parseOpenshipConfig({ services: [{ name: "x", restart: "sometimes" }] });
    expect(badRestart.errors.some((e) => e.includes("restart"))).toBe(true);
  });

  it("warns on unknown top-level keys but does not error", () => {
    const { errors, warnings, config } = parseOpenshipConfig({ framework: "vite", nope: 1 });
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("nope"))).toBe(true);
    expect(config?.framework).toBe("vite");
  });

  it("reports invalid JSON and non-object roots", () => {
    expect(parseOpenshipConfigJson("{ not json").errors[0]).toMatch(/invalid JSON/);
    expect(parseOpenshipConfig([]).config).toBeNull();
    expect(parseOpenshipConfig("x").errors[0]).toMatch(/must be a JSON object/);
  });

  // The examples printed in the docs/skill must validate cleanly, or the docs
  // are lying. Keep these in sync with reference/openship-json.mdx.
  it("accepts every documented example with no errors", () => {
    const examples = [
      { $schema: "x", framework: "vite", buildCommand: "pnpm build", outputDirectory: "dist", productionMode: "static" },
      {
        $schema: "x", framework: "nextjs", port: 3000, runtime: "docker",
        env: { NEXT_PUBLIC_URL: "https://app.acme.com", DATABASE_URL: { value: "postgres://…", secret: true } },
        domains: ["app.acme.com"],
      },
      {
        $schema: "x",
        services: [
          { name: "web", build: ".", ports: ["3000"], exposed: true, domain: "app.acme.com" },
          { name: "db", image: "postgres:17", volumes: ["pgdata:/var/lib/postgresql/data"], env: { POSTGRES_PASSWORD: { value: "…", secret: true } }, restart: "unless-stopped" },
        ],
      },
      {
        $schema: "x",
        monorepo: {
          workspace: { packageManager: "pnpm", prepareCommand: "pnpm install && pnpm codegen" },
          apps: [
            { name: "web", rootDirectory: "apps/web", framework: "nextjs", port: 3000 },
            { name: "api", rootDirectory: "apps/api", framework: "hono", port: 8080 },
          ],
        },
      },
      { $schema: "x", domains: ["app.acme.com", { domain: "api.acme.com", port: 8080, type: "custom" }] },
    ];
    for (const ex of examples) {
      const { errors } = parseOpenshipConfig(ex);
      expect(errors, JSON.stringify(ex)).toEqual([]);
    }
  });
});
