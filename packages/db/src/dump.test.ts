import { describe, expect, test } from "vitest";
import { getTableColumns } from "drizzle-orm";
import * as schema from "./schema";
import { filterRowToKnownColumns } from "./dump";

// Cross-version ingest tolerance for restoreSubgraph (cloud transfer / project
// transfer). Drizzle builds the INSERT column list from the dumped row's keys =
// the SENDER's schema. When a freshly-updated instance dumps into a receiver on
// an OLDER schema, a sender-only column would make Postgres reject the whole
// insert. restoreSubgraph filters every row to the receiver's known columns
// first; this locks that filter against the REAL project schema.

const projectCols = new Set(Object.keys(getTableColumns(schema.project)));

describe("filterRowToKnownColumns (version-skew ingest tolerance)", () => {
  test("drops sender-only columns the receiver schema does not model", () => {
    const { row, dropped } = filterRowToKnownColumns(
      {
        id: "proj_1",
        name: "app",
        // columns a NEWER sender might carry that this build lacks:
        someFutureColumn: "v0.9.0",
        anotherNewField: 42,
      },
      projectCols,
    );
    expect(dropped.sort()).toEqual(["anotherNewField", "someFutureColumn"]);
    expect(row).not.toHaveProperty("someFutureColumn");
    expect(row).not.toHaveProperty("anotherNewField");
    // Real columns survive untouched.
    expect(row.id).toBe("proj_1");
    expect(row.name).toBe("app");
  });

  test("keeps every real project column and drops nothing when the row matches", () => {
    const full: Record<string, unknown> = {};
    for (const k of projectCols) full[k] = null;
    const { row, dropped } = filterRowToKnownColumns(full, projectCols);
    expect(dropped).toEqual([]);
    expect(new Set(Object.keys(row))).toEqual(projectCols);
  });

  test("preserves falsy/null values for known columns (does not treat them as absent)", () => {
    const { row, dropped } = filterRowToKnownColumns(
      { id: "proj_2", autoDeploy: false, activeDeploymentId: null, unknownX: "drop" },
      projectCols,
    );
    expect(dropped).toEqual(["unknownX"]);
    expect(row).toHaveProperty("autoDeploy", false);
    expect(row).toHaveProperty("activeDeploymentId", null);
  });
});
