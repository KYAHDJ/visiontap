/**
 * VisionTap - Google Apps Script web app
 * ---------------------------------------
 * Paste this into the Apps Script editor of the Google Sheet linked to your
 * VisionTap Google Form (Sheet -> Extensions -> Apps Script). Then Deploy ->
 * New deployment -> Web app -> "Anyone" -> Deploy. Copy the resulting
 * /exec URL into data_feed_config.json (FEED_URL).
 *
 * It reads the response rows from the linked form's Sheet and returns them as
 * JSON (newest first), so the GitHub Pages site can render them.
 */
function doGet(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var values = sheet.getDataRange().getValues();
  if (values.length <= 1) {
    return json_({ ok: true, rows: [] });
  }

  var headers = values[0]; // first row = column headers
  function col(name) {
    for (var i = 0; i < headers.length; i++) {
      var h = String(headers[i]).toLowerCase().replace(/\s+/g, " ");
      if (h.indexOf(name.toLowerCase()) >= 0) return i;
    }
    return -1;
  }

  var cTime = col("Timestamp") >= 0 ? col("Timestamp") : col("time");
  var cBatt = col("Battery");
  var cAnimal = col("Animal");
  var cCount = col("Count");
  var cCorrect = col("Correct");
  var cTotal = col("Total time");
  var cWdraw = col("Withdrawable");

  var rows = [];
  // Start at row 1 (skip headers). Newest last in sheet => go from bottom up.
  for (var r = values.length - 1; r >= 1; r--) {
    var v = values[r];
    rows.push({
      timestamp: pick(v, cTime),
      battery: num(pick(v, cBatt)),
      animal: str(pick(v, cAnimal)),
      count: num(pick(v, cCount)),
      correct: toBool(str(pick(v, cCorrect))),
      totalSec: num(pick(v, cTotal)),
      withdrawable: str(pick(v, cWdraw))
    });
  }
  return json_({ ok: true, rows: rows });
}

function pick(v, i) { return (i >= 0 && i < v.length) ? v[i] : null; }
function str(x) { return x == null ? null : String(x); }
function num(x) { return (x == null || x === "") ? null : Number(x); }
function toBool(x) { if (!x) return null; var s = String(x).toLowerCase(); return s === "true" || s === "yes" || s === "1"; }
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
