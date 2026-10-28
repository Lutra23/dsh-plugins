// Static contract guard for the turn-tail action row.
//
// The transcript UI is rendered by the host, so there is no React in this
// repository to mount the component. This test instead pins the source-level
// contract that the browser half must keep:
//   - three action buttons in the turn tail, each with a stable data attribute
//   - regenerate wired to the fork pipeline with the ORIGINAL user text
//   - an empty-text guard so regenerate can never degrade into "rewind only"
//   - both locale dictionaries carrying every new key
//
// Run: node test/static-contract.cjs   (no dependencies)

const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "client.js"), "utf8");
let failed = 0;

function check(label, ok) {
  if (ok) {
    console.log(`  ok    ${label}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL  ${label}`);
}

function count(needle) {
  return source.split(needle).length - 1;
}

console.log("turn-tail action buttons");
for (const attr of ["data-rewind-regenerate", "data-rewind-edit", "data-rewind-only"]) {
  check(`${attr} present exactly once`, count(attr) === 1);
}
const regenAt = source.indexOf('"data-rewind-regenerate"');
const editAt = source.indexOf('"data-rewind-edit"');
const rewindAt = source.indexOf('"data-rewind-only"');
check("render order is regenerate -> edit -> rewind", regenAt > 0 && regenAt < editAt && editAt < rewindAt);

console.log("\nregenerate behaviour");
check('regenerate dispatch exists', source.includes('planAndThen("regenerate")'));
check("empty-text guard exists", source.includes('original.trim().length === 0'));
check("empty-text notice is user-visible", source.includes('setNotice(t("rewind.regenEmpty"))'));
check("original prompt is resent", source.includes("rewindApi.run(plan.boundarySeq, original)"));
check("busy notice exists", source.includes('setNotice(t("rewind.regenBusy"))'));

console.log("\nlocale dictionaries");
for (const key of ["rewind.regenTitle", "rewind.regenConfirm", "rewind.regenEmpty", "rewind.regenBusy"]) {
  check(`${key} in zh`, source.includes(`"${key}":`));
  check(`${key} in en`, count(`"${key}":`) === 2);
}

console.log("\nslot registration");
check("turnTail slot registration kept", source.includes('name: "conversation.chat.turnTail"'));

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
