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
const MAX_COLUMNS = 10;
const MAX_CELL_CHARS = 1000;
const MAX_SHEETS = 10;
const MAX_ZIP_ENTRIES = 5000;
const MAX_ZIP_UNCOMPRESSED = 64 * 1024 * 1024;
const MAX_ZIP_ENTRY = 16 * 1024 * 1024;
const MAX_ZIP_RATIO = 200;
const SUPPORTED_EXTENSIONS = new Set(['.xlsx', '.csv']);

function preflightXlsxZip(buffer) {
  const minEocd = 22;
  if (buffer.length < minEocd) throw new Error('The spreadsheet archive is incomplete.');
  const searchStart = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let offset = buffer.length - minEocd; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('The spreadsheet archive has no central directory.');
  const entries = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error('ZIP64 spreadsheets are not supported.');
  }
  if (entries > MAX_ZIP_ENTRIES) throw new Error('The spreadsheet archive has too many entries.');
  let offset = directoryOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('The spreadsheet archive central directory is corrupt.');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if (flags & 0x1) throw new Error('Encrypted spreadsheet archives are not supported.');
    if (uncompressed > MAX_ZIP_ENTRY) throw new Error('The spreadsheet archive contains an oversized entry.');
    if (compressed > 0 && uncompressed / compressed > MAX_ZIP_RATIO) {
      throw new Error('The spreadsheet archive is compressed too aggressively.');
    }
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED) {
      throw new Error('The spreadsheet archive expands beyond the allowed size.');
    }
    if (offset + 46 + nameLength > buffer.length) {
      throw new Error('The spreadsheet archive central directory is corrupt.');
    }
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (
      name.length > 255 ||
      name.startsWith('/') ||
      name.startsWith('\\') ||
      name.split(/[\\/]/).some((part) => part === '..')
    ) {
      throw new Error('The spreadsheet archive contains an unsafe path.');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

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
  if (extension === '.xlsx') preflightXlsxZip(buffer);
  if (extension === '.csv' && (buffer.toString('utf8').match(/\n/g) || []).length > MAX_ROWS * 10) {
    throw new Error('The CSV file has too many rows.');
  }

  let workbook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      raw: true,
      cellDates: false,
      sheetRows: MAX_ROWS + 3,
      dense: true
    });
  } catch (error) {
    throw new Error('This file could not be read. Use a valid .xlsx or .csv file.');
  }
  if (workbook.SheetNames.length > MAX_SHEETS) throw new Error('The spreadsheet has too many sheets.');
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('The spreadsheet has no sheets.');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    blankrows: false,
    raw: true,
    defval: ''
  });
  let cellCount = 0;
  for (const row of rows) {
    if (row.length > MAX_COLUMNS) throw new Error(`Spreadsheet rows are limited to ${MAX_COLUMNS} columns.`);
    for (const cell of row) {
      cellCount += 1;
      if (cellCount > MAX_ROWS * MAX_COLUMNS * 2) throw new Error('The spreadsheet has too many cells.');
      if (typeof cell === 'string' && cell.length > MAX_CELL_CHARS) {
        throw new Error('A spreadsheet cell is too long.');
      }
    }
  }
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
          if (warnings.length < 20) warnings.push(`Ambiguous number "${raw}" needs a country code or leading 0.`);
        }
        invalid += 1;
        continue;
      }
      if (parsed.assumedLocalZero) {
        assumedLocalZero += 1;
        if (warnings.length < 20) warnings.push(`Assumed Algerian local format for "${raw}" because the spreadsheet removed its leading zero.`);
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
