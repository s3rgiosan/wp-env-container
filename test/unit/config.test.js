'use strict';
const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );
const {
	applyTestsPhpmyadminPort,
	getStateRoot,
	MAX_PROJECT_ID_LENGTH,
	readAutoPort,
	remapPaths,
	toProjectId,
} = require( '../../lib/config' );
const recipes = require( '../../lib/runtime/recipes' );
const { isDebugEnabled } = require( '../../lib/debug' );
const { makeTempDir } = require( '../helpers/temp' );

test( 'remapPaths rewrites paths under the work directory only', () => {
	const input = {
		core: '/home/.wp-env/project/WordPress',
		exact: '/home/.wp-env/project',
		sibling: '/home/.wp-env/project-other/WordPress',
		local: '/projects/plugin',
		list: [ '/home/.wp-env/project/tests-WordPress', 8888, null ],
	};

	const output = remapPaths(
		input,
		'/home/.wp-env/project',
		'/state/project'
	);

	assert.deepEqual( output, {
		core: '/state/project/WordPress',
		exact: '/state/project',
		sibling: '/home/.wp-env/project-other/WordPress',
		local: '/projects/plugin',
		list: [ '/state/project/tests-WordPress', 8888, null ],
	} );
} );

/**
 * Runs `callback` with `WP_ENV_CONTAINER_HOME` set (or unset when null).
 *
 * @param {?string}      home     State home, or null to unset the variable.
 * @param {() => string} callback Function to run.
 * @return {string} The callback's return value.
 */
function withHome( home, callback ) {
	const previous = process.env.WP_ENV_CONTAINER_HOME;
	if ( home === null ) {
		delete process.env.WP_ENV_CONTAINER_HOME;
	} else {
		process.env.WP_ENV_CONTAINER_HOME = home;
	}
	try {
		return callback();
	} finally {
		if ( previous === undefined ) {
			delete process.env.WP_ENV_CONTAINER_HOME;
		} else {
			process.env.WP_ENV_CONTAINER_HOME = previous;
		}
	}
}

test( 'toProjectId keeps only characters valid in container names', () =>
	withHome( null, () => {
		assert.equal(
			toProjectId( '/home/.wp-env/wp-env-My Plugin (v2)+x-1a2b3c4d' ),
			'wp-env-My-Plugin-v2-x-1a2b3c4d'
		);
		assert.equal( toProjectId( '/home/.wp-env/_@weird' ), 'weird' );
		assert.equal(
			toProjectId( '/home/.wp-env/wp-env-plain.name_1-abcd' ),
			'wp-env-plain.name_1-abcd'
		);
	} ) );

test( 'toProjectId keeps the id under the default home', () => {
	const id = '/home/.wp-env/wp-env-demo-1a2b3c4d';
	const defaultHome = path.join( os.homedir(), '.wp-env-container' );
	assert.equal(
		withHome( null, () => toProjectId( id ) ),
		'wp-env-demo-1a2b3c4d'
	);
	assert.equal(
		withHome( defaultHome, () => toProjectId( id ) ),
		'wp-env-demo-1a2b3c4d'
	);
} );

test( 'toProjectId gives each custom home its own stable id', () => {
	const dir = '/home/.wp-env/wp-env-demo-1a2b3c4d';
	const first = withHome( '/srv/state-a', () => toProjectId( dir ) );
	const again = withHome( '/srv/state-a', () => toProjectId( dir ) );
	const second = withHome( '/srv/state-b', () => toProjectId( dir ) );
	assert.equal( first, again );
	assert.notEqual( first, second );
	assert.match( first, /^wp-env-demo-1a2b3c4d-[0-9a-f]{6}$/ );
	assert.match( first, /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/ );
} );

test( 'toProjectId gives a state root and a symlink to it the same id', () => {
	const dir = '/home/.wp-env/wp-env-demo-1a2b3c4d';
	const root = fs.realpathSync.native( makeTempDir( 'wpec-home-' ) );
	const link = `${ root }-link`;
	fs.symlinkSync( root, link );
	try {
		const real = withHome( root, () => toProjectId( dir ) );
		assert.equal(
			withHome( link, () => toProjectId( dir ) ),
			real
		);
		assert.equal(
			withHome( path.join( link, 'state' ), () => getStateRoot() ),
			path.join( root, 'state' )
		);
		assert.equal(
			withHome( path.join( link, 'state' ), () => toProjectId( dir ) ),
			withHome( path.join( root, 'state' ), () => toProjectId( dir ) )
		);
	} finally {
		fs.rmSync( link );
	}
} );

test( 'toProjectId keeps the id of a state root that is created later', () => {
	const dir = '/home/.wp-env/wp-env-demo-1a2b3c4d';
	const parent = makeTempDir( 'wpec-home-' );
	const root = path.join( parent, 'later', 'state' );
	const before = withHome( root, () => toProjectId( dir ) );
	const rootBefore = withHome( root, () => getStateRoot() );
	fs.mkdirSync( root, { recursive: true } );

	assert.equal(
		withHome( root, () => toProjectId( dir ) ),
		before
	);
	assert.equal(
		withHome( root, () => getStateRoot() ),
		rootBefore
	);
	assert.equal( rootBefore, fs.realpathSync.native( root ) );
} );

test( 'toProjectId matches a state root written with other letter case on a case-insensitive disk', ( t ) => {
	const dir = '/home/.wp-env/wp-env-demo-1a2b3c4d';
	const root = fs.realpathSync.native( makeTempDir( 'wpec-Home-' ) );
	const upper = path.join(
		path.dirname( root ),
		path.basename( root ).toUpperCase()
	);
	if ( ! fs.existsSync( upper ) ) {
		t.skip( 'the temporary folder is on a case-sensitive disk' );
		return;
	}

	assert.equal(
		withHome( upper, () => toProjectId( dir ) ),
		withHome( root, () => toProjectId( dir ) )
	);
} );

test( 'getStateRoot expands a leading ~ to the home folder', () => {
	const home = fs.realpathSync.native( os.homedir() );

	assert.equal(
		withHome( '~/wpec-example-state', () => getStateRoot() ),
		path.join( home, 'wpec-example-state' )
	);
	assert.equal(
		withHome( '~', () => getStateRoot() ),
		home
	);
	assert.equal(
		withHome( path.join( os.homedir(), '.wp-env-container' ), () =>
			toProjectId( '/home/.wp-env/wp-env-demo-1a2b3c4d' )
		),
		withHome( '~/.wp-env-container', () =>
			toProjectId( '/home/.wp-env/wp-env-demo-1a2b3c4d' )
		)
	);
} );

test( 'toProjectId shortens a long id so every container name fits in 63 characters', () => {
	const longName = `wp-env-${ 'a-very-long-project-folder-name'.repeat( 3 ) }-staging`;
	const dirA = `/home/.wp-env/${ longName }-1a2b3c4d`;
	const dirB = `/home/.wp-env/${ longName }-5e6f7a8b`;

	const ids = [
		withHome( null, () => toProjectId( dirA ) ),
		withHome( null, () => toProjectId( dirB ) ),
		withHome( '/srv/state-a', () => toProjectId( dirA ) ),
	];

	assert.equal( new Set( ids ).size, 3 );
	assert.match( ids[ 0 ], /^wp-env-a-very-long-.*-1a2b3c4d$/ );
	assert.match( ids[ 2 ], /^wp-env-a-very-long-.*-1a2b3c4d-[0-9a-f]{6}$/ );
	for ( const id of ids ) {
		assert.ok( id.length <= MAX_PROJECT_ID_LENGTH, id );
		assert.match( id, /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/ );
		const names = [
			...Object.values( recipes.containerNames( id ) ),
			`${ id }-phpunit-a1b2c3`,
			`${ id }-wpcli-a1b2c3`,
			`${ id }-run-a1b2c3`,
		];
		for ( const name of names ) {
			assert.ok( name.length <= 63, name );
		}
	}
	assert.equal(
		withHome( null, () =>
			toProjectId( '/home/.wp-env/wp-env-demo-1a2b3c4d' )
		),
		'wp-env-demo-1a2b3c4d'
	);
} );

test( 'isDebugEnabled treats empty, 0, false, no and off as off', () => {
	for ( const value of [
		undefined,
		'',
		'0',
		'false',
		'FALSE',
		'no',
		'No',
		'off',
		'OFF',
	] ) {
		assert.equal( isDebugEnabled( value ), false, String( value ) );
	}
	for ( const value of [ '1', 'true', 'yes', 'on', 'anything' ] ) {
		assert.equal( isDebugEnabled( value ), true, value );
	}
} );

test( 'isDebugEnabled reads WP_ENV_CONTAINER_DEBUG by default', () => {
	const saved = process.env.WP_ENV_CONTAINER_DEBUG;
	try {
		process.env.WP_ENV_CONTAINER_DEBUG = '0';
		assert.equal( isDebugEnabled(), false );
		process.env.WP_ENV_CONTAINER_DEBUG = '1';
		assert.equal( isDebugEnabled(), true );
		delete process.env.WP_ENV_CONTAINER_DEBUG;
		assert.equal( isDebugEnabled(), false );
	} finally {
		if ( saved === undefined ) {
			delete process.env.WP_ENV_CONTAINER_DEBUG;
		} else {
			process.env.WP_ENV_CONTAINER_DEBUG = saved;
		}
	}
} );

test( 'readAutoPort reads autoPort with the override file winning', async () => {
	const directory = makeTempDir( 'wpec-config-' );
	const write = ( name, value ) =>
		fs.writeFileSync(
			path.join( directory, name ),
			JSON.stringify( value )
		);

	assert.equal( await readAutoPort( directory, null ), false );

	write( '.wp-env.json', { autoPort: true } );
	assert.equal( await readAutoPort( directory, null ), true );

	write( '.wp-env.override.json', { autoPort: false } );
	assert.equal( await readAutoPort( directory, null ), false );

	write( 'staging.json', {} );
	write( 'staging.override.json', { autoPort: true } );
	assert.equal(
		await readAutoPort( directory, path.join( directory, 'staging.json' ) ),
		true
	);
} );

/**
 * Runs `callback` with `WP_ENV_TESTS_PHPMYADMIN_PORT` set (or unset when null).
 *
 * @param {?string}       value    Variable value, or null to unset it.
 * @param {() => unknown} callback Function to run.
 * @return {unknown} The callback's return value.
 */
function withTestsPhpmyadminPort( value, callback ) {
	const variable = 'WP_ENV_TESTS_PHPMYADMIN_PORT';
	const previous = process.env[ variable ];
	if ( value === null ) {
		delete process.env[ variable ];
	} else {
		process.env[ variable ] = value;
	}
	try {
		return callback();
	} finally {
		if ( previous === undefined ) {
			delete process.env[ variable ];
		} else {
			process.env[ variable ] = previous;
		}
	}
}

test( 'applyTestsPhpmyadminPort sets the tests port and turns phpMyAdmin on', () => {
	const config = {
		env: {
			development: { phpmyadmin: false },
			tests: { phpmyadmin: false, phpmyadminPort: null },
		},
	};

	const applied = withTestsPhpmyadminPort( '8995', () =>
		applyTestsPhpmyadminPort( config )
	);

	assert.deepEqual( applied.env.tests, {
		phpmyadmin: true,
		phpmyadminPort: 8995,
	} );
	assert.deepEqual( applied.env.development, { phpmyadmin: false } );
	assert.equal( config.env.tests.phpmyadmin, false );
} );

test( 'applyTestsPhpmyadminPort leaves the config alone without the variable', () => {
	const config = { env: { development: {}, tests: {} } };

	for ( const value of [ null, '', '0' ] ) {
		const applied = withTestsPhpmyadminPort( value, () =>
			applyTestsPhpmyadminPort( config )
		);
		assert.equal( applied, config );
	}
} );
