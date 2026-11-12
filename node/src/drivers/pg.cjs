// The PostgreSQL driver as one unit: build.sh bundles this file into release/drivers/pg.cjs (pure JavaScript, no pg-native), which dbdrivers.cjs loads on first use
module.exports = { pg: require('pg'), Cursor: require('pg-cursor') }
