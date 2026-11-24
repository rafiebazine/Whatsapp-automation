const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dist = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(dist)) process.exit(0);
for (const name of fs.readdirSync(dist)) {
  const file = path.join(dist, name);
  if (!fs.statSync(file).isFile() || name.endsWith('.sha256')) continue;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(`${file}.sha256`, `${hash}  ${name}\n`);
}
