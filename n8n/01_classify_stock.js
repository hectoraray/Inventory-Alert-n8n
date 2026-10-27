// n8n "Code" node 1 of 2  -  Mode: "Run Once for All Items"  -  Language: JavaScript
//
// Input : one item per inventory row read from the Google Sheet
//         (sku, product_name, category, stock, reorder_point, supplier, last_alert_status)
// Output: the same rows plus
//           status          OUT | CRITICAL | LOW | OK | DATA_ERROR
//           previous_status what the sheet says we already alerted (blank = OK)
//           should_notify   true only when severity ESCALATED (or a new data error)
//           needs_update    true when the sheet's last_alert_status must change
//
// Why "last_alert_status"? It makes the workflow idempotent: a product that stays LOW
// does not trigger a new alert every run. The sheet is the single source of truth.

const RANK = { OK: 0, LOW: 1, CRITICAL: 2, OUT: 3 };

function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  const text = String(value).trim();
  if (text === "") return NaN;   // Number("") would be 0, which would hide a data error
  return Number(text);
}

return $input.all().map((item) => {
  const row = item.json;
  const stock = toNumber(row.stock);
  const reorderPoint = toNumber(row.reorder_point);
  const previous = String(row.last_alert_status ?? "").trim().toUpperCase() || "OK";

  let status;
  let issue = "";
  if (!Number.isFinite(stock) || stock < 0) {
    status = "DATA_ERROR";
    issue = `invalid stock: "${row.stock}"`;
  } else if (!Number.isFinite(reorderPoint) || reorderPoint <= 0) {
    status = "DATA_ERROR";
    issue = `invalid reorder_point: "${row.reorder_point}"`;
  } else if (stock === 0) {
    status = "OUT";
  } else if (stock <= reorderPoint * 0.5) {
    status = "CRITICAL";
  } else if (stock <= reorderPoint) {
    status = "LOW";
  } else {
    status = "OK";
  }

  const escalated = (RANK[status] ?? 0) > (RANK[previous] ?? 0);
  const newDataError = status === "DATA_ERROR" && previous !== "DATA_ERROR";

  return {
    json: {
      ...row,
      stock_num: stock,
      reorder_point_num: reorderPoint,
      status,
      issue,
      previous_status: previous,
      should_notify: escalated || newDataError,
      needs_update: status !== previous,
    },
  };
});
