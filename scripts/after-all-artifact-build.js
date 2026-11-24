const fs = require('fs');
const crypto = require('crypto');

module.exports = async function afterAllArtifactBuild(context) {
  const created = [];
  for (const file of context.artifactPaths || []) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const target = `${file}.sha256`;
    fs.writeFileSync(target, `${hash}  ${require('path').basename(file)}\n`);
    created.push(target);
  }
  return created;
};
