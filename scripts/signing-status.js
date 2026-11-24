const CERTIFICATE_VARIABLES = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD'
];

const configured = CERTIFICATE_VARIABLES.filter((name) => Boolean(process.env[name]));
const status = {
  configured,
  unsigned: configured.length === 0,
  guidance: 'Set CSC_LINK/CSC_KEY_PASSWORD or WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD in the CI environment before signing release artifacts. Values are never printed.'
};

console.log(JSON.stringify(status, null, 2));
