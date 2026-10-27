// n8n "Code" node 2 of 2  -  Mode: "Run Once for All Items"  -  Language: JavaScript
//
// Input : only the rows where should_notify = true (an IF/Filter node sits before this one,
//         so when nothing needs attention this node never runs and no message is sent).
// Output: ONE item with a single, grouped message (not one message per product = no spam).

const MAX_PER_GROUP = 15;      // keep the message readable
const MAX_LENGTH = 3900;       // Telegram limit is 4096 characters

const rows = $input.all().map((i) => i.json);

const sections = [
  ["OUT", "🔴 OUT OF STOCK"],
  ["CRITICAL", "🟠 CRITICAL (at or below 50% of reorder point)"],
  ["LOW", "🟡 LOW (at or below reorder point)"],
  ["DATA_ERROR", "⚠️ DATA ISSUES (fix them in the sheet)"],
];

const line = (r) =>
  r.status === "DATA_ERROR"
    ? `• ${r.sku} ${r.product_name} — ${r.issue}`
    : `• ${r.sku} ${r.product_name} — stock ${r.stock_num} (reorder at ${r.reorder_point_num}) · ${r.supplier}`;

const counts = {};
const blocks = [];
for (const [key, title] of sections) {
  const group = rows.filter((r) => r.status === key);
  counts[key] = group.length;
  if (group.length === 0) continue;
  const shown = group.slice(0, MAX_PER_GROUP).map(line);
  const extra = group.length - shown.length;
  blocks.push([`${title} — ${group.length}`, ...shown, extra > 0 ? `…and ${extra} more` : null]
    .filter(Boolean)
    .join("\n"));
}

let message = [`📦 Inventory alert: ${rows.length} item(s) need attention`, ...blocks].join("\n\n");
if (message.length > MAX_LENGTH) {
  message = message.slice(0, MAX_LENGTH) + "\n…(message truncated)";
}

return [{ json: { message, total: rows.length, counts } }];
