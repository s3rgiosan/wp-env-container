'use strict';
const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const path = require( 'path' );

const FORBIDDEN_PACKAGES = [ 'simple-git', 'js-yaml', 'argparse', 'qs' ];

test( 'the package entry exposes the runtime and its errors', () => {
	const api = require( '../../lib' );

	assert.equal( typeof api.AppleContainerRuntime, 'function' );
	assert.equal( typeof api.CommandRunningError, 'function' );
	assert.equal( typeof api.EnvironmentNotRunningError, 'function' );
	assert.ok(
		new api.CommandRunningError( [ { name: 'a' } ] ) instanceof Error
	);
} );

test( 'loading the library does not pull in the wp-env download and parsing packages', () => {
	require( '../../lib' );
	require( '../../lib/cli' );
	require( '../../lib/config' );
	require( '../../lib/mcp/server' );

	const separator = path.sep;
	const loaded = Object.keys( require.cache ).filter( ( file ) =>
		FORBIDDEN_PACKAGES.some( ( name ) =>
			file.includes(
				`${ separator }node_modules${ separator }${ name }${ separator }`
			)
		)
	);

	assert.deepEqual( loaded, [] );
} );
