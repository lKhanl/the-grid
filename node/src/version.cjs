// The version of this build. build.cjs embeds it (esbuild define) from package.json, the one place the version lives;
// run from source (tests, dev) it is read from package.json directly.
module.exports = typeof __GRID_VERSION__ !== 'undefined' ? __GRID_VERSION__ : require('../package.json').version
