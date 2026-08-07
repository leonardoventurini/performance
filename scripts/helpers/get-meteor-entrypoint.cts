const fs = require('fs');

/** Resolves a Meteor main module without coupling legacy scripts to app layout. */
function getMeteorEntrypoint(appPath: string, clientOrServer: string = 'client'): string {
  const rawData = fs.readFileSync(`${appPath}/package.json`);
  const jsonData = JSON.parse(rawData);
  const entrypoint = jsonData?.meteor?.mainModule?.[clientOrServer];
  if (!entrypoint) return '';
  return `${appPath}/${entrypoint}`;
}

// Check if script is run directly
if (require.main === module) {
  const appPath = process.argv[2];
  const clientOrServer = process.argv[3] || 'client';
  if (appPath === undefined) throw new Error('missing application path');
  console.log(getMeteorEntrypoint(appPath, clientOrServer));
}

// Export the function for external execution
module.exports = getMeteorEntrypoint;
