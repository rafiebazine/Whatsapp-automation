const XLSX = require('xlsx');
const {
  parsePhoneNumber,
  normalizeJid,
  isPnJid,
  isLidJid,
  phoneDigits,
  sanitizeContactName
} = require('./identity');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 5000;
const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.csv']);

function parseSpreadsheet(name, bytes) {
  const fileName = String(name || 'spreadsheet');
  const extension = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error('Unsupported file type. Use a .xlsx or .csv file.');
  }
  if (!bytes) throw new Error('The selected file is empty.');
  const buffer = Buffer.from(bytes);
  if (!buffer.length) throw new Error('The selected file is empty.');
  if (buffer.length > MAX_BYTES) throw new Error('The file is too large. Use a file under 8 MB.');

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', raw: true, cellDates: false });
  } catch (error) {
    throw new Error('This file could not be read. Use a valid .xlsx or .csv file.');
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('The spreadsheet has no sheets.');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    blankrows: false,
    raw: true,
    defval: ''
  });
  if (!rows.length) throw new Error('The spreadsheet has no data rows.');

  const first = rows[0].map((cell) => String(cell || '').toLowerCase().trim());
  const looksLikeHeader =
    first.some((cell) => /number|phone|telephone|num[eé]ro|mobile/.test(cell)) &&
    first.some((cell) => /name|nom/.test(cell));
  const dataRows = looksLikeHeader ? rows.slice(1) : rows;
  const limitedRows = dataRows.slice(0, MAX_ROWS);

  const result = [];
  const seen = new Set();
  let invalid = 0;
  let duplicate = 0;
  let ambiguous = 0;
  let assumedLocalZero = 0;
  const warnings = [];
  for (const row of limitedRows) {
    const rawCell = row[0];
    const raw = String(rawCell || '').trim();
    const rawName = String(row[1] || '').trim();
    if (!raw && !rawName) continue;

    let jid = '';
    let phoneNumber = '';
    let number = '';
    if (raw.includes('@')) {
      jid = normalizeJid(raw);
      if (!isPnJid(jid) && !isLidJid(jid)) {
        invalid += 1;
        continue;
      }
      phoneNumber = phoneDigits(jid.split('@')[0]) || '';
      number = phoneNumber ? `+${phoneNumber}` : jid;
    } else {
      const numericCell = typeof rawCell === 'number';
      const parsed = parsePhoneNumber(raw, numericCell ? { assumeAlgerianLocal: true } : {});
      if (!parsed.valid) {
        if (parsed.ambiguous) {
          ambiguous += 1;
          warnings.push(`Ambiguous number "${raw}" needs a country code or leading 0.`);
        }
        invalid += 1;
        continue;
      }
      if (parsed.assumedLocalZero) {
        assumedLocalZero += 1;
        warnings.push(`Assumed Algerian local format for "${raw}" because the spreadsheet removed its leading zero.`);
      }
      phoneNumber = parsed.digits;
      number = parsed.canonical;
      jid = `${phoneNumber}@s.whatsapp.net`;
    }

    const key = jid;
    if (seen.has(key)) {
      duplicate += 1;
      continue;
    }
    seen.add(key);
    result.push({ number, jid, name: sanitizeContactName(rawName) });
  }

  if (!result.length) {
    throw new Error('No valid phone numbers or WhatsApp identities were found.');
  }

  return {
    rows: result,
    stats: {
      totalRows: limitedRows.length,
      valid: result.length,
      invalid,
      duplicate,
      ambiguous,
      assumedLocalZero,
      warnings,
      truncated: Math.max(0, dataRows.length - limitedRows.length)
    }
  };
}

module.exports = { parseSpreadsheet };
