// Tests for the two n8n Code nodes. Run with:  node --test
//
// The Code-node scripts expect n8n's global `$input`. Here we load each script and run it
// with a fake `$input`, so the exact code that is pasted into n8n is what gets tested.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const classifySrc = fs.readFileSync(path.join(ROOT, "n8n", "01_classify_stock.js"), "utf8");
const messageSrc = fs.readFileSync(path.join(ROOT, "n8n", "02_build_message.js"), "utf8");

function runNode(source, rows) {
  const $input = { all: () => rows.map((json) => ({ json })) };
  return new Function("$input", source)($input).map((item) => item.json);
}
const classify = (rows) => runNode(classifySrc, rows);
const buildMessage = (rows) => runNode(messageSrc, rows)[0];

// Minimal CSV reader (the sample file has no quoted commas)
function readCsv(file) {
  const [header, ...lines] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  const keys = header.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [keys[i], v])));
}

const row = (over = {}) => ({
  sku: "SKU-X", product_name: "Test Product", category: "Test",
  stock: "100", reorder_point: "20", supplier: "ACME", last_alert_status: "", ...over,
});
const statusOf = (over) => classify([row(over)])[0];

// ------------------------------------------------------------------ classification
test("status thresholds: OK / LOW / CRITICAL / OUT", () => {
  assert.equal(statusOf({ stock: "21" }).status, "OK");
  assert.equal(statusOf({ stock: "20" }).status, "LOW");      // at the reorder point
  assert.equal(statusOf({ stock: "11" }).status, "LOW");
  assert.equal(statusOf({ stock: "10" }).status, "CRITICAL"); // exactly 50%
  assert.equal(statusOf({ stock: "1" }).status, "CRITICAL");
  assert.equal(statusOf({ stock: "0" }).status, "OUT");
});

test("numbers arriving as strings, numbers or with spaces are all handled", () => {
  assert.equal(statusOf({ stock: 5, reorder_point: 20 }).status, "CRITICAL");
  assert.equal(statusOf({ stock: " 5 ", reorder_point: " 20 " }).status, "CRITICAL");
  assert.equal(statusOf({ stock: 0 }).status, "OUT");         // numeric zero is valid stock
});

test("bad data is flagged, never silently treated as zero or ignored", () => {
  for (const stock of ["", "   ", "n/a", "abc", null, undefined, "-3"]) {
    const r = statusOf({ stock });
    assert.equal(r.status, "DATA_ERROR", `stock=${JSON.stringify(stock)}`);
    assert.match(r.issue, /invalid stock/);
  }
  for (const reorder_point of ["", "0", "-5", "x"]) {
    const r = statusOf({ reorder_point });
    assert.equal(r.status, "DATA_ERROR", `reorder_point=${JSON.stringify(reorder_point)}`);
    assert.match(r.issue, /invalid reorder_point/);
  }
});

// ------------------------------------------------------------------ dedupe / escalation
test("a new problem notifies and updates the sheet", () => {
  const r = statusOf({ stock: "5", last_alert_status: "" });
  assert.equal(r.should_notify, true);
  assert.equal(r.needs_update, true);
});

test("same status as last time: no notification, no update (no alert spam)", () => {
  const r = statusOf({ stock: "15", last_alert_status: "LOW" });
  assert.equal(r.status, "LOW");
  assert.equal(r.should_notify, false);
  assert.equal(r.needs_update, false);
});

test("escalation (LOW -> CRITICAL -> OUT) notifies again", () => {
  assert.equal(statusOf({ stock: "5", last_alert_status: "LOW" }).should_notify, true);
  assert.equal(statusOf({ stock: "0", last_alert_status: "CRITICAL" }).should_notify, true);
});

test("de-escalation updates the sheet silently", () => {
  const r = statusOf({ stock: "15", last_alert_status: "OUT" });
  assert.equal(r.status, "LOW");
  assert.equal(r.should_notify, false);
  assert.equal(r.needs_update, true);
});

test("recovery to OK clears the alert state without notifying", () => {
  const r = statusOf({ stock: "200", last_alert_status: "CRITICAL" });
  assert.equal(r.status, "OK");
  assert.equal(r.should_notify, false);
  assert.equal(r.needs_update, true);
});

test("blank, 'OK' and odd casing of last_alert_status are equivalent / normalised", () => {
  assert.equal(statusOf({ stock: "200", last_alert_status: "" }).needs_update, false);
  assert.equal(statusOf({ stock: "200", last_alert_status: "OK" }).needs_update, false);
  assert.equal(statusOf({ stock: "15", last_alert_status: "  low " }).should_notify, false);
});

test("a missing last_alert_status column (Sheets omits empty cells) is treated as blank", () => {
  const r = { ...row({ stock: "5" }) };
  delete r.last_alert_status;
  const out = classify([r])[0];
  assert.equal(out.previous_status, "OK");
  assert.equal(out.should_notify, true);
});

test("a data error is reported once, then not repeated every run", () => {
  assert.equal(statusOf({ stock: "", last_alert_status: "" }).should_notify, true);
  assert.equal(statusOf({ stock: "", last_alert_status: "DATA_ERROR" }).should_notify, false);
});

test("idempotent: running again after the sheet is updated produces no new alerts", () => {
  const rows = readCsv(path.join(ROOT, "data", "inventory_sample.csv"));
  const firstRun = classify(rows);
  const updated = firstRun.map((r) => ({
    sku: r.sku, product_name: r.product_name, category: r.category, stock: r.stock,
    reorder_point: r.reorder_point, supplier: r.supplier,
    last_alert_status: r.status === "OK" ? "" : r.status,
  }));
  const secondRun = classify(updated);
  assert.equal(secondRun.filter((r) => r.should_notify).length, 0);
  assert.equal(secondRun.filter((r) => r.needs_update).length, 0);
});

test("sample inventory produces exactly the expected result", () => {
  const out = classify(readCsv(path.join(ROOT, "data", "inventory_sample.csv")));
  const count = (s) => out.filter((r) => r.status === s).length;
  assert.equal(out.length, 22);
  assert.deepEqual(
    { OK: count("OK"), LOW: count("LOW"), CRITICAL: count("CRITICAL"), OUT: count("OUT"), DATA_ERROR: count("DATA_ERROR") },
    { OK: 13, LOW: 2, CRITICAL: 4, OUT: 1, DATA_ERROR: 2 },
  );
  const notified = out.filter((r) => r.should_notify).map((r) => r.sku);
  assert.deepEqual(notified, ["SKU-004", "SKU-006", "SKU-008", "SKU-014", "SKU-017", "SKU-019", "SKU-022"]);
});

// ------------------------------------------------------------------ message
test("message groups by severity, most urgent first, in one message", () => {
  const rows = classify(readCsv(path.join(ROOT, "data", "inventory_sample.csv")))
    .filter((r) => r.should_notify);
  const { message, total, counts } = buildMessage(rows);
  assert.equal(total, 7);
  assert.deepEqual(counts, { OUT: 1, CRITICAL: 4, LOW: 0, DATA_ERROR: 2 });
  assert.match(message, /^📦 Inventory alert: 7 item\(s\) need attention/);
  assert.ok(message.indexOf("OUT OF STOCK") < message.indexOf("CRITICAL"));
  assert.ok(message.indexOf("CRITICAL") < message.indexOf("DATA ISSUES"));
  assert.ok(!message.includes("LOW (at or below"), "empty groups are omitted");
  assert.match(message, /SKU-006 Canvas Backpack — stock 0 \(reorder at 15\) · Cuero Andino/);
  assert.match(message, /SKU-019 Resistance Bands — invalid stock: "n\/a"/);
});

test("a huge alert list stays under Telegram's 4096-character limit", () => {
  const many = Array.from({ length: 500 }, (_, i) =>
    row({ sku: `SKU-${i}`, product_name: "A fairly long product name for testing", stock: "1", supplier: "Some Supplier" }));
  const { message } = buildMessage(classify(many).filter((r) => r.should_notify));
  assert.ok(message.length <= 4096, `length was ${message.length}`);
  assert.match(message, /and 485 more/);
});
