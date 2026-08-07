const fs = require('fs');

/** Prints the app-local Meteor package configuration for legacy diagnostics. */
function printMeteorConfig(appPath: string): void {
  const rawData = fs.readFileSync(`${appPath}/package.json`);
  const jsonData = JSON.parse(rawData);
  const meteorConfig = jsonData?.meteor;

  console.log(JSON.stringify(meteorConfig, null, 2));
}

if (require.main === module) {
  const appPath = process.argv[2];
  if (appPath === undefined) throw new Error('missing application path');
  printMeteorConfig(appPath);
}

// Export the function for external execution
module.exports = printMeteorConfig;
