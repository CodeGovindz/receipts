import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLAIM_BUDGET_CHARS,
  eachPatchLine,
  enrichChangedFiles,
  isSkippablePath,
  isTestFile,
  parseHunkRanges,
  selectHunksForClaim,
  splitPatchHunks,
  type PatchLine,
} from "../diff";
import type { Claim } from "../types";

function claim(partial: Partial<Claim> & Pick<Claim, "text" | "category">): Claim {
  return {
    quote: partial.quote ?? "",
    source: partial.source ?? "pr_body",
    scope: partial.scope ?? "unspecified",
    ...partial,
  } satisfies Claim;
}

const MULTI_HUNK_PATCH = `@@ -10,4 +10,9 @@
 context
-old line
+new line
+another new line
 context
@@ -50,3 +50,2 @@
 context
-removed line
 context`;

describe("parseHunkRanges", () => {
  it("parses a new-file hunk (@@ -0,0 +1,20 @@)", () => {
    expect(parseHunkRanges("@@ -0,0 +1,20 @@\n+one\n+two")).toEqual([{ newStart: 1, newLines: 20 }]);
  });

  it("parses a deletion-only hunk as an empty new-file range (@@ -42,7 +0,0 @@)", () => {
    expect(parseHunkRanges("@@ -42,7 +0,0 @@\n-removed")).toEqual([{ newStart: 0, newLines: 0 }]);
  });

  it("defaults the omitted count to 1 (@@ -5 +5 @@)", () => {
    expect(parseHunkRanges("@@ -5 +5 @@\n ctx")).toEqual([{ newStart: 5, newLines: 1 }]);
  });

  it("parses multiple hunks", () => {
    expect(parseHunkRanges(MULTI_HUNK_PATCH)).toEqual([
      { newStart: 10, newLines: 9 },
      { newStart: 50, newLines: 2 },
    ]);
  });

  it("ignores non-header lines", () => {
    expect(parseHunkRanges("+@@ fake\n@@ -1,2 +3,4 @@\n+added")).toEqual([
      { newStart: 3, newLines: 4 },
    ]);
  });
});

describe("splitPatchHunks", () => {
  it("splits hunks with header content and spans, dropping diff metadata", () => {
    const patch = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
${MULTI_HUNK_PATCH}`;
    const hunks = splitPatchHunks(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].startLine).toBe(10);
    expect(hunks[0].endLine).toBe(18);
    expect(hunks[0].content.startsWith("@@ -10,4 +10,9 @@")).toBe(true);
    expect(hunks[0].content).toContain("+new line");
    expect(hunks[1].endLine).toBe(51);
    expect(hunks[0].content).not.toContain("diff --git");
  });
});

describe("eachPatchLine", () => {
  it("resolves new-file and old-file line numbers across hunks", () => {
    const patch = `@@ -10,2 +10,4 @@
 context-10
-old-11
+add-10
+add-11
@@ -20,1 +14,1 @@
-old-20
+add-14`;
    const lines: Array<PatchLine & { text: string }> = [];
    eachPatchLine(patch, (entry) => lines.push(entry));
    const kinds = lines.map((line) => `${line.kind}:${line.line}:${line.text}`).join(" ");
    expect(kinds).toBe(
      "context:10:context-10 del:11:old-11 add:11:add-10 add:12:add-11 del:20:old-20 add:14:add-14",
    );
  });
});

describe("isTestFile", () => {
  it.each([
    ["src/parser.test.ts", true],
    ["src/__tests__/parser.spec.js", true],
    ["tests/test_parser.py", true],
    ["pkg/handler_test.go", true],
    ["src/CalculatorTest.java", true],
    ["cypress/e2e/login_spec.ts", true],
    ["src/lib/parser.ts", false],
    ["src/contest.ts", false],
    ["src/test-data/fixture.ts", false],
    ["docs/testing.md", false],
  ])("%s -> %s", (path, expected) => {
    expect(isTestFile(path)).toBe(expected);
  });
});

describe("isSkippablePath", () => {
  it.each([
    ["package-lock.json", true],
    ["pnpm-lock.yaml", true],
    ["Cargo.lock", true],
    ["dist/bundle.min.js", true],
    ["assets/logo.png", true],
    ["src/lib/__snapshots__/parser.snap", true],
    ["node_modules/left-pad/x.js", true],
    ["package.json", false],
    ["src/lib/parser.ts", false],
    ["docs/README.md", false],
  ])("%s -> %s", (path, expected) => {
    expect(isSkippablePath(path)).toBe(expected);
  });
});

describe("enrichChangedFiles", () => {
  it("drops lockfile patches but keeps their hunk ranges and metadata", () => {
    const [enriched] = enrichChangedFiles([
      {
        path: "package-lock.json",
        previousPath: null,
        status: "modified",
        additions: 500,
        deletions: 2,
        patch: "@@ -1,3 +1,5 @@\n+a\n+b",
      },
    ]);
    expect(enriched.excluded).toBe(true);
    expect(enriched.patch).toBeNull();
    expect(enriched.hunks).toEqual([{ newStart: 1, newLines: 5 }]);
    expect(enriched.additions).toBe(500);
  });

  it("caps a patch at 400 lines", () => {
    const body = Array.from({ length: 500 }, (_, index) => `+line-${index}`).join("\n");
    const [enriched] = enrichChangedFiles([
      {
        path: "src/big.ts",
        previousPath: null,
        status: "modified",
        additions: 500,
        deletions: 0,
        patch: `@@ -0,0 +1,500 @@\n${body}`,
      },
    ]);
    expect(enriched.patchTruncated).toBe(true);
    expect(enriched.patch !== null && enriched.patch.split("\n").length).toBeLessThanOrEqual(400);
    // Hunk ranges come from the FULL patch, so the guard still sees them all.
    expect(enriched.hunks).toEqual([{ newStart: 1, newLines: 500 }]);
  });

  it("enforces the 60k total budget across files", () => {
    const bigPatch = `@@ -1,1 +1,1 @@\n+${"x".repeat(35_000)}`;
    const files = enrichChangedFiles([
      {
        path: "src/first-a.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: bigPatch,
      },
      {
        path: "src/second-b.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: bigPatch,
      },
    ]);
    const total =
      files.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(60_000);
    expect(files.find((file) => file.path === "src/first-a.ts")?.patch).not.toBeNull();
  });
});

describe("selectHunksForClaim", () => {
  const testPatch = `@@ -1,2 +1,4 @@
+describe("login handler", () => {
+  it("accepts a valid token", () => {});
+});`;
  const sourcePatch = `@@ -40,3 +40,9 @@
 context line
+function validateLogin(login) {
+  return Boolean(login);
+}
+
+// Additional validation logic keeps the login flow honest about
+// tokens, so that the session helper can normalize user input.
+const loginValidationHelper = { validateLogin };`;
  const bigDocsPatch = `@@ -1,1 +1,2 @@
+# Documentation
+Very long documentation about the installer, the runner, and the output formats.`;

  function testBundleFiles() {
    return enrichChangedFiles([
      {
        path: "src/login.test.ts",
        previousPath: null,
        status: "modified",
        additions: 3,
        deletions: 0,
        patch: testPatch,
      },
      {
        path: "src/login.ts",
        previousPath: null,
        status: "modified",
        additions: 3,
        deletions: 1,
        patch: sourcePatch,
      },
      {
        path: "docs/installer.md",
        previousPath: null,
        status: "modified",
        additions: 2,
        deletions: 0,
        patch: bigDocsPatch,
      },
    ]);
  }

  it("routes tests_added claims to test files first", () => {
    const hunks = selectHunksForClaim(
      claim({
        text: "Added unit tests for the login handler",
        quote: "Added unit tests for the login handler",
        category: "tests_added",
      }),
      { files: testBundleFiles() },
    );
    expect(hunks.length).toBeGreaterThan(0);
    expect(hunks[0].path).toBe("src/login.test.ts");
  });

  it("routes docs_updated claims to markdown files first", () => {
    const hunks = selectHunksForClaim(
      claim({ text: "Updated documentation for the installer", category: "docs_updated" }),
      { files: testBundleFiles() },
    );
    expect(hunks[0].path).toBe("docs/installer.md");
  });

  it("matches by keyword and prefers matching hunks", () => {
    const hunks = selectHunksForClaim(
      claim({ text: "validateLogin now returns a boolean", category: "bug_fixed" }),
      { files: testBundleFiles() },
    );
    expect(hunks[0].path).toBe("src/login.ts");
  });

  it("falls back to the largest non-test hunks when nothing matches", () => {
    const hunks = selectHunksForClaim(
      claim({ text: "Made everything much faster", category: "performance" }),
      { files: testBundleFiles() },
    );
    expect(hunks.length).toBeGreaterThan(0);
    const paths = hunks.map((hunk) => hunk.path);
    expect(paths).not.toContain("src/login.test.ts");
    // The source hunk is the largest non-test hunk.
    expect(paths[0]).toBe("src/login.ts");
  });

  it("never exceeds the char budget", () => {
    const hunks = selectHunksForClaim(
      claim({ text: "Added unit tests for the login handler", category: "tests_added" }),
      { files: testBundleFiles() },
      200,
    );
    const total = hunks.reduce((sum, hunk) => sum + hunk.content.length, 0);
    expect(total).toBeLessThanOrEqual(200 + 40); // truncation marker allowance
  });

  it("returns [] for a bundle with no usable patches", () => {
    const files = enrichChangedFiles([
      {
        path: "yarn.lock",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1,1 +1,1 @@\n-a\n+b",
      },
    ]);
    const hunks = selectHunksForClaim(
      claim({ text: "Everything works", category: "other" }),
      { files },
    );
    expect(hunks).toEqual([]);
  });

  it("default budget matches the plan contract", () => {
    expect(DEFAULT_CLAIM_BUDGET_CHARS).toBe(12_000);
  });
});
