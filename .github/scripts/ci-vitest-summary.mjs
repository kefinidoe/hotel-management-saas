import { readFileSync } from "node:fs";

const [file, platform] = process.argv.slice(2);
if (!file || !["linux", "windows"].includes(platform)) throw new Error("Usage: ci-vitest-summary.mjs <json-report> <linux|windows>");
const report = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(report.testResults) || !Number.isInteger(report.numTotalTests)) throw new Error("Invalid Vitest report");
const tests = report.testResults.flatMap((suite) => suite.assertionResults.map((test) => ({ ...test, file: suite.name.replaceAll("\\", "/") })));
const skipped = tests.filter((test) => ["pending", "skipped", "todo"].includes(test.status));
const run = tests.filter((test) => !["pending", "skipped", "todo"].includes(test.status));
console.log(`Tests run: ${run.length}; passed: ${report.numPassedTests}; failed: ${report.numFailedTests}; skipped/todo: ${skipped.length}; total: ${report.numTotalTests}`);
console.log(`::notice::${platform} tests: ${report.numPassedTests} passed, ${report.numFailedTests} failed, ${skipped.length} skipped/todo, ${report.numTotalTests} total`);
if (tests.length !== report.numTotalTests || skipped.length !== report.numPendingTests + report.numTodoTests) throw new Error("Incomplete or inconsistent Vitest report");
if (skipped.length) {
  console.log("Skipped tests (full names):");
  for (const test of skipped) console.log(`  ${test.file}: ${test.fullName} [${test.status}]`);
} else console.log("Skipped tests: none");
const required = [
  ["__tests__/security/auth-rate-limit.integration.test.ts", 14],
  ["__tests__/scripts/cleanup-disposable.integration.test.ts", 5],
  ["__tests__/scripts/migration-evidence-tools.test.ts", null],
  ["__tests__/scripts/archive-toc.test.ts", null],
];
console.log("Real-Postgres suites:");
for (const [name, expected] of required) {
  const cases = tests.filter((test) => test.file.endsWith(name));
  const passed = cases.filter((test) => test.status === "passed").length;
  if (!cases.length) throw new Error(`Required suite missing from report: ${name}`);
  console.log(`  ${name}: ${passed} passed, ${cases.length - passed} not passed`);
  if (platform === "linux" && expected !== null && (cases.length !== expected || passed !== expected)) throw new Error(`Real-Postgres suite did not run in full: ${name}`);
}
if (platform === "linux") {
  for (const title of [
    "restores an archive whose schema comment refers to an excluded schema",
    "restores when a retained function references an excluded schema",
    "names the SQL statement that broke the restore",
    "analyses a real archive and prints the report",
    "has no admin API route in the production app manifest",
  ]) {
    const matches = tests.filter((test) => test.title === title && test.status === "passed");
    if (matches.length !== 1) throw new Error(`Required real-server or manifest assertion did not pass: ${title}`);
    console.log(`  PASSED: ${title}`);
  }
}
if (platform === "windows") console.log("Windows: guarded rate-limit and cleanup suites require Linux /proc postmaster identity checks and a marked local cluster; skipped cases are listed above.");
if (platform === "linux" && skipped.length) throw new Error("Linux baseline forbids skipped or todo tests");
if (!report.success || report.numFailedTests) throw new Error("Vitest reported failures");
