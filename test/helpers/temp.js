'use strict';
const { after } = require( 'node:test' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );

const directories = [];

after( () => {
	for ( const directory of directories ) {
		fs.rmSync( directory, { recursive: true, force: true } );
	}
} );

/**
 * Creates a temporary directory that is removed when the test file finishes.
 *
 * @param {string} prefix
 * @return {string} Absolute path.
 */
function makeTempDir( prefix ) {
	const directory = fs.mkdtempSync( path.join( os.tmpdir(), prefix ) );
	directories.push( directory );
	return directory;
}

module.exports = { makeTempDir };
