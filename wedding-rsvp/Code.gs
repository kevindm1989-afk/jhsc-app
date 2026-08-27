/**
 * Rudy & Sarah — wedding RSVP backend (Google Apps Script).
 *
 * Paste this over the code in your Apps Script project, then:
 *   Deploy ▸ Manage deployments ▸ edit the existing deployment
 *   Execute as: Me     Who has access: Anyone
 *   Deploy (this keeps the same /exec URL both pages already use).
 *
 * doGet  returns every response as JSON objects with stable key names.
 * doPost appends one response, creating the header row if the sheet is empty.
 */

var SHEET_NAME = 'RSVPs';
var HEADERS    = ['Timestamp', 'Name', 'Attending', 'Guests', 'Meal', 'Message', 'Email'];

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  try {
    var sheet = getSheet();
    if (sheet.getLastRow() < 2) return json([]);

    // Display values keep the timestamp readable instead of a raw Date object.
    var values  = sheet.getDataRange().getDisplayValues();
    var headers = values[0];
    var out     = [];

    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var rec = {};
      var blank = true;
      for (var c = 0; c < headers.length; c++) {
        var key = String(headers[c] || '').trim();
        if (!key) continue;
        rec[key] = row[c];
        if (String(row[c] || '').trim()) blank = false;
      }
      if (!blank) out.push(rec);
    }
    return json(out);
  } catch (err) {
    return json({ result: 'error', error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);   // serialise concurrent RSVPs so no row is lost

    var body = {};
    if (e && e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents); } catch (parseErr) { body = {}; }
    }
    // Also accept a plain form post, just in case.
    if ((!body || !body.name) && e && e.parameter) body = e.parameter;

    var name = String(body.name || '').trim();
    if (!name) return json({ result: 'error', error: 'Name is required' });

    var attending = String(body.attending || '').trim();
    attending = /^(yes|y|true|1|attending)$/i.test(attending) ? 'Yes' : 'No';

    var guests = parseInt(body.guests, 10);
    if (isNaN(guests) || guests < 0) guests = attending === 'Yes' ? 1 : 0;

    var sheet = getSheet();
    var row = {
      Timestamp: new Date(),
      Name:      name,
      Attending: attending,
      Guests:    guests,
      Meal:      String(body.meal    || '').trim(),
      Message:   String(body.message || '').trim(),
      Email:     String(body.email   || '').trim()
    };

    // Write by header name, so re-ordering the sheet columns cannot scramble it.
    var headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), HEADERS.length))
                       .getDisplayValues()[0];
    var line = headers.map(function (h) {
      var key = String(h || '').trim();
      return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : '';
    });
    sheet.appendRow(line);

    return json({ result: 'success', row: sheet.getLastRow() });
  } catch (err) {
    return json({ result: 'error', error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}
