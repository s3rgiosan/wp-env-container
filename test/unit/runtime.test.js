'use strict';
const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const fs = require( 'fs' );
const path = require( 'path' );
const {
	AppleContainerRuntime,
	EnvironmentNotRunningError,
	configHash,
} = require( '../../lib/runtime/apple-container' );
const recipes = require( '../../lib/runtime/recipes' );
const sources = require( '../../lib/runtime/sources' );
const { makeConfig } = require( '../helpers/config' );
const { makeTempDir } = require( '../helpers/temp' );

// `CI` turns automatic port selection off, so every test runs without it and
// the test that needs it sets it itself.
const savedCI = process.env.CI;
test.before( () => {
	delete process.env.CI;
} );
test.after( () => {
	if ( savedCI !== undefined ) {
		process.env.CI = savedCI;
	}
} );

/**
 * Records `container` invocations (`exec` and `run`) and answers `inspect`
 * from a table.
 *
 * @param {Object}                                       [options]
 * @param {Object}                                       [options.containers] Inspect results keyed by container name.
 * @param {(args: string[], options: Object) => ?Object} [options.onExec]     Answers an `exec` call; return nothing for the default result.
 * @return {Object} The fake CLI.
 */
function fakeCLI( { containers = {}, onExec } = {} ) {
	const calls = [];
	return {
		calls,
		list: async () => [],
		listByLabels: async () => [],
		listImages: async () => [],
		imageExists: async () => false,
		imageDigest: async () => null,
		inspect: async ( name ) => containers[ name ] || null,
		exec: async ( args, options ) => {
			calls.push( args );
			return onExec
				? onExec( args, options )
				: { exitCode: 0, stdout: '', stderr: '', timedOut: false };
		},
		run: async ( args ) => {
			calls.push( args );
			return '';
		},
	};
}

const RUNNING = {
	'example-project-mysql': { state: 'running', ipAddress: '192.168.64.9' },
	'example-project-tests-mysql': {
		state: 'running',
		ipAddress: '192.168.64.10',
	},
	'example-project-tests-wordpress': { state: 'running' },
};

/**
 * @param {Object} cli Fake container CLI.
 * @return {AppleContainerRuntime} A runtime whose port checks never touch the host network.
 */
function makeRuntime( cli ) {
	const runtime = new AppleContainerRuntime( { cli, log: () => {} } );
	runtime.isPortFree = async () => true;
	runtime.pickRandomPort = async () => 50100;
	return runtime;
}

/**
 * @param {Object} [overrides] Values merged over the default config.
 * @return {Object} A config whose state folder is a new temporary directory, so the project lock can be taken.
 */
function lockedConfig( overrides = {} ) {
	return makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
		...overrides,
	} );
}

const TESTS_DISABLED =
	'The tests environment is disabled ("testsEnvironment": false in .wp-env.json).';

function withTTY( isTTY, callback ) {
	const streams = [ process.stdin, process.stdout ];
	const saved = streams.map( ( stream ) =>
		Object.getOwnPropertyDescriptor( stream, 'isTTY' )
	);
	for ( const stream of streams ) {
		Object.defineProperty( stream, 'isTTY', {
			value: isTTY,
			configurable: true,
			writable: true,
		} );
	}
	return Promise.resolve()
		.then( callback )
		.finally( () => {
			streams.forEach( ( stream, index ) => {
				if ( saved[ index ] ) {
					Object.defineProperty( stream, 'isTTY', saved[ index ] );
				} else {
					delete stream.isTTY;
				}
			} );
		} );
}

test( 'wpCli refuses to run when the database is down', async () => {
	const runtime = makeRuntime( fakeCLI() );

	await assert.rejects(
		runtime.wpCli( lockedConfig(), 'tests', [ 'option', 'list' ] ),
		( error ) =>
			error instanceof EnvironmentNotRunningError &&
			error.message ===
				'The tests database is not running. Start the environment with `wp-env-container start`.'
	);
} );

test( 'wpCli and phpunit run against the tests database', async () => {
	const root = makeTempDir( 'wpec-test-' );
	const config = makeConfig( {
		stateDirectoryPath: path.join( root, 'state' ),
	} );
	const cli = fakeCLI( { containers: RUNNING } );
	const runtime = makeRuntime( cli );

	await runtime.wpCli( config, 'tests', [ 'option', 'list' ] );
	await runtime.phpunit( config );

	for ( const args of cli.calls ) {
		assert.ok( args.includes( 'WORDPRESS_DB_HOST=192.168.64.10' ) );
		assert.ok( args.includes( 'WORDPRESS_DB_NAME=tests-wordpress' ) );
	}
} );

test( 'wpCli refuses the tests environment when it is disabled', async () => {
	const cli = fakeCLI( { containers: RUNNING } );

	await assert.rejects(
		makeRuntime( cli ).wpCli(
			makeConfig( { testsEnvironment: false } ),
			'tests',
			[ 'option', 'list' ]
		),
		{ message: TESTS_DISABLED }
	);
	assert.equal( cli.calls.length, 0 );
} );

test( 'wpCli stops its CLI container on timeout and reports timedOut', async () => {
	let timeoutOptions;
	const cli = fakeCLI( {
		containers: RUNNING,
		onExec: async ( args, options ) => {
			if ( options?.timeoutMs ) {
				timeoutOptions = options;
				await options.onTimeout();
				return {
					exitCode: 143,
					stdout: '',
					stderr: '',
					timedOut: true,
				};
			}
			return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
		},
	} );

	const result = await makeRuntime( cli ).wpCli(
		lockedConfig(),
		'tests',
		[ 'cron', 'event', 'run' ],
		{ timeoutMs: 500 }
	);

	const name = cli.calls[ 0 ][ cli.calls[ 0 ].indexOf( '--name' ) + 1 ];
	assert.match( name, /^example-project-wpcli-/ );
	assert.equal( timeoutOptions.timeoutMs, 500 );
	assert.deepEqual( cli.calls[ 1 ], [ 'stop', name ] );
	assert.deepEqual( result, {
		exitCode: 143,
		stdout: '',
		stderr: '',
		timedOut: true,
	} );
} );

test( 'wpCli reports timedOut false when the command finishes', async () => {
	const cli = fakeCLI( { containers: RUNNING } );

	const result = await makeRuntime( cli ).wpCli( lockedConfig(), 'tests', [
		'option',
		'list',
	] );

	assert.equal( result.timedOut, false );
} );

test( 'phpunit prefers vendor/bin/phpunit, logs JUnit and parses the report', async () => {
	const root = makeTempDir( 'wpec-test-' );
	const pluginPath = path.join( root, 'plugin' );
	fs.mkdirSync( path.join( pluginPath, 'vendor', 'bin' ), {
		recursive: true,
	} );
	fs.writeFileSync( path.join( pluginPath, 'vendor', 'bin', 'phpunit' ), '' );

	const config = makeConfig( {
		stateDirectoryPath: path.join( root, 'state' ),
	} );
	config.env.tests.pluginSources = [
		{ type: 'local', path: pluginPath, basename: 'example-plugin' },
	];

	const cli = fakeCLI( {
		containers: RUNNING,
		onExec: async ( args ) => {
			const reportArg = args[ args.indexOf( '--log-junit' ) + 1 ];
			const reportPath = path.join(
				root,
				'state',
				'reports',
				'tests',
				path.basename( reportArg )
			);
			fs.writeFileSync(
				reportPath,
				'<testsuites><testsuite tests="2" assertions="2" errors="0" failures="0" skipped="0" time="0.1"></testsuite></testsuites>'
			);
			return {
				exitCode: 0,
				stdout: 'OK (2 tests, 2 assertions)',
				stderr: '',
				timedOut: false,
			};
		},
	} );

	const result = await makeRuntime( cli ).phpunit( config, {
		filter: 'test_answer',
	} );

	const args = cli.calls[ 0 ];
	assert.equal(
		args[ args.indexOf( '-w' ) + 1 ],
		'/var/www/html/wp-content/plugins/example-plugin'
	);
	assert.ok( args.includes( 'vendor/bin/phpunit' ) );
	assert.equal( args[ args.indexOf( '--filter' ) + 1 ], 'test_answer' );
	assert.equal( result.passed, true );
	assert.equal( result.phpunit, 'vendor/bin/phpunit' );
	assert.equal( result.summary.tests, 2 );
	assert.equal(
		fs.readdirSync( path.join( root, 'state', 'reports', 'tests' ) ).length,
		0
	);
} );

test( 'phpunit falls back to the global PHPUnit and reports a missing JUnit file', async () => {
	const root = makeTempDir( 'wpec-test-' );
	const config = makeConfig( {
		stateDirectoryPath: path.join( root, 'state' ),
	} );
	const cli = fakeCLI( {
		containers: RUNNING,
		onExec: async () => ( {
			exitCode: 2,
			stdout: '',
			stderr: 'Could not read phpunit.xml',
			timedOut: false,
		} ),
	} );

	const result = await makeRuntime( cli ).phpunit( config );

	assert.ok( cli.calls[ 0 ].includes( 'phpunit' ) );
	assert.equal( result.passed, false );
	assert.equal( result.summary, null );
	assert.equal( result.output, 'Could not read phpunit.xml' );
} );

test( 'hostPathFor maps container paths back to mounted host folders', () => {
	const runtime = makeRuntime( fakeCLI() );
	const config = makeConfig();

	assert.equal(
		runtime.hostPathFor( config, 'wp-content/plugins/example-plugin' ),
		'/projects/example-plugin'
	);
	assert.equal(
		runtime.hostPathFor(
			config,
			'/var/www/html/wp-content/plugins/example-plugin/tests'
		),
		'/projects/example-plugin/tests'
	);
	assert.equal(
		runtime.hostPathFor( config, 'wp-content/plugins/other' ),
		'/state/example-project/tests-WordPress/wp-content/plugins/other'
	);
} );

test( 'debugLogPath follows a custom WP_DEBUG_LOG path inside the install', () => {
	const runtime = makeRuntime( fakeCLI() );
	const config = makeConfig();

	assert.equal(
		runtime.debugLogPath( config, 'tests' ),
		'/state/example-project/tests-WordPress/wp-content/debug.log'
	);
	config.env.tests.config.WP_DEBUG_LOG = '/var/www/html/logs/debug.log';
	assert.equal(
		runtime.debugLogPath( config, 'tests' ),
		'/state/example-project/tests-WordPress/logs/debug.log'
	);
} );

test( 'run rejects an unknown container', async () => {
	const runtime = makeRuntime( fakeCLI( { containers: RUNNING } ) );

	await assert.rejects(
		runtime.run( makeConfig(), {
			container: 'tests-phpmyadmin',
			command: [ 'ls' ],
		} ),
		/Unknown container "tests-phpmyadmin"/
	);
} );

test( 'clean refuses the tests environment when it is disabled', async () => {
	const runtime = makeRuntime( fakeCLI( { containers: RUNNING } ) );

	await assert.rejects(
		runtime.clean( makeConfig( { testsEnvironment: false } ) ),
		{ message: TESTS_DISABLED }
	);
} );

test( 'clean all skips a disabled tests environment', async () => {
	const root = makeTempDir( 'wpec-test-' );
	const config = makeConfig( {
		stateDirectoryPath: root,
		testsEnvironment: false,
	} );
	const cli = fakeCLI( { containers: RUNNING } );
	const runtime = makeRuntime( cli );
	const configured = [];
	runtime.configureWordPress = async ( _config, env ) =>
		configured.push( env );

	await runtime.clean( config, { environment: 'all' } );

	assert.deepEqual( configured, [ 'development' ] );
} );

test( 'clean tests resets the tests database only and reinstalls with the published port', async () => {
	const root = makeTempDir( 'wpec-test-' );
	const config = makeConfig( { stateDirectoryPath: root } );
	const cli = fakeCLI( { containers: RUNNING } );
	cli.listByLabels = async () => [
		{
			name: 'example-project-tests-wordpress',
			state: 'running',
			ports: [ { hostPort: 8895, containerPort: 80 } ],
		},
	];
	const runtime = makeRuntime( cli );
	const configured = [];
	runtime.configureWordPress = async ( started, env, dbHost ) =>
		configured.push( [
			env,
			dbHost,
			started.env[ env ].config.WP_SITEURL,
		] );

	await runtime.clean( config, { environment: 'tests' } );

	assert.equal( cli.calls.length, 1 );
	assert.ok( cli.calls[ 0 ].includes( 'WORDPRESS_DB_HOST=192.168.64.10' ) );
	assert.deepEqual( cli.calls[ 0 ].slice( -4 ), [
		'wp',
		'db',
		'reset',
		'--yes',
	] );
	assert.deepEqual( configured, [
		[ 'tests', '192.168.64.10', 'http://localhost:8895' ],
	] );
	const state = JSON.parse(
		fs.readFileSync( path.join( root, 'environments.json' ), 'utf8' )
	);
	assert.deepEqual( state, { tests: { siteUrl: 'http://localhost:8895' } } );
} );

test( 'run always forwards stdin and allocates a TTY only for terminals', async () => {
	const cli = fakeCLI( {
		containers: {
			...RUNNING,
			'example-project-wordpress': { state: 'running' },
		},
	} );
	const runtime = makeRuntime( cli );
	const config = lockedConfig();

	await withTTY( false, () =>
		runtime.run( config, { container: 'wordpress', command: [ 'ls' ] } )
	);
	await withTTY( true, () =>
		runtime.run( config, { container: 'wordpress', command: [ 'ls' ] } )
	);
	await withTTY( false, () =>
		runtime.run( config, {
			container: 'cli',
			command: [ 'wp', 'db', 'import', '-' ],
		} )
	);
	await withTTY( true, () =>
		runtime.run( config, { container: 'cli', command: [ 'wp', 'shell' ] } )
	);

	assert.deepEqual( cli.calls[ 0 ].slice( 0, 4 ), [
		'exec',
		'-i',
		'-w',
		'/var/www/html',
	] );
	assert.deepEqual( cli.calls[ 1 ].slice( 0, 5 ), [
		'exec',
		'-i',
		'-t',
		'-w',
		'/var/www/html',
	] );
	assert.ok( cli.calls[ 2 ].includes( '-i' ) );
	assert.ok( ! cli.calls[ 2 ].includes( '-t' ) );
	assert.ok( cli.calls[ 3 ].includes( '-i' ) );
	assert.ok( cli.calls[ 3 ].includes( '-t' ) );
} );

test( 'run in mysql defaults the working directory to /', async () => {
	const cli = fakeCLI( { containers: RUNNING } );
	const runtime = makeRuntime( cli );

	await withTTY( false, () =>
		runtime.run( lockedConfig(), {
			container: 'mysql',
			command: [ 'mariadb' ],
		} )
	);
	await withTTY( false, () =>
		runtime.run( lockedConfig(), {
			container: 'mysql',
			command: [ 'ls' ],
			envCwd: '/tmp',
		} )
	);

	assert.deepEqual( cli.calls[ 0 ], [
		'exec',
		'-i',
		'-w',
		'/',
		'example-project-mysql',
		'mariadb',
	] );
	assert.deepEqual( cli.calls[ 1 ], [
		'exec',
		'-i',
		'-w',
		'/tmp',
		'example-project-mysql',
		'ls',
	] );
} );

test( 'run in tests-mysql uses the tests database container from /', async () => {
	const cli = fakeCLI( { containers: RUNNING } );
	const runtime = makeRuntime( cli );

	await withTTY( false, () =>
		runtime.run( lockedConfig(), {
			container: 'tests-mysql',
			command: [ 'pwd' ],
		} )
	);

	assert.deepEqual( cli.calls[ 0 ], [
		'exec',
		'-i',
		'-w',
		'/',
		'example-project-tests-mysql',
		'pwd',
	] );
	await assert.rejects(
		makeRuntime( fakeCLI() ).run( lockedConfig(), {
			container: 'tests-mysql',
			command: [ 'pwd' ],
		} ),
		{
			message:
				'The tests database is not running. Start the environment with `wp-env-container start`.',
		}
	);
} );

test( 'run refuses tests containers when the tests environment is disabled', async () => {
	const runtime = makeRuntime( fakeCLI( { containers: RUNNING } ) );
	const config = makeConfig( { testsEnvironment: false } );

	await assert.rejects(
		runtime.run( config, { container: 'tests-cli', command: [ 'ls' ] } ),
		{ message: TESTS_DISABLED }
	);
	await assert.rejects(
		runtime.run( config, {
			container: 'tests-wordpress',
			command: [ 'ls' ],
		} ),
		{ message: TESTS_DISABLED }
	);
	await assert.rejects(
		runtime.run( config, {
			container: 'tests-mysql',
			command: [ 'ls' ],
		} ),
		{ message: TESTS_DISABLED }
	);
} );

/**
 * A runtime whose database is ready at once, recording `container` calls.
 *
 * @param {Object} record Fields merged into the running database container's inspect result.
 * @return {{cli: Object, runtime: AppleContainerRuntime, config: Object, running: Set<string>, recreated: () => boolean}} The runtime and its fixtures.
 */
function databaseRuntime( record ) {
	const cli = fakeCLI( {
		containers: {
			'example-project-mysql': {
				state: 'running',
				ipAddress: '192.168.64.9',
				ports: [],
				...record,
			},
		},
	} );
	const runtime = makeRuntime( cli );
	const root = makeTempDir( 'wpec-test-' );
	const config = makeConfig( {
		stateDirectoryPath: root,
		testsEnvironment: false,
	} );
	const running = new Set( [ 'example-project-mysql' ] );
	const recreated = () => cli.calls.some( ( args ) => args[ 0 ] === 'run' );
	return { cli, runtime, config, running, recreated };
}

test( 'startDatabase keeps a running database that matches the config', async () => {
	const { runtime, config, running, recreated } = databaseRuntime( {
		image: 'docker.io/library/mariadb:lts',
	} );

	assert.equal(
		await runtime.startDatabase( config, 'development', running ),
		'192.168.64.9'
	);
	assert.equal( recreated(), false );
} );

test( 'startDatabase recreates a running database with another image', async () => {
	const { cli, runtime, config, running, recreated } = databaseRuntime( {
		image: 'docker.io/library/mariadb:10',
	} );

	await runtime.startDatabase( config, 'development', running );

	assert.ok( recreated() );
	assert.deepEqual( cli.calls.slice( 0, 2 ), [
		[ 'stop', 'example-project-mysql' ],
		[ 'delete', '--force', 'example-project-mysql' ],
	] );
	assert.equal( cli.calls[ 2 ].at( -1 ), 'mariadb:lts' );
} );

test( 'startDatabase recreates a running database when its port changes', async () => {
	const { cli, runtime, config, running, recreated } = databaseRuntime( {
		image: 'docker.io/library/mariadb:lts',
	} );

	await runtime.startDatabase( config, 'development', running, {
		port: 13306,
	} );

	assert.ok( recreated() );
	const run = cli.calls.find( ( args ) => args[ 0 ] === 'run' );
	assert.equal( run[ run.indexOf( '-p' ) + 1 ], '127.0.0.1:13306:3306' );
} );

test( 'startDatabase recreates a running database published on all interfaces', async () => {
	const { runtime, config, running, recreated } = databaseRuntime( {
		image: 'docker.io/library/mariadb:lts',
		ports: [
			{
				hostAddress: '0.0.0.0',
				hostPort: 13306,
				containerPort: 3306,
				proto: 'tcp',
			},
		],
	} );

	await runtime.startDatabase( config, 'development', running, {
		port: 13306,
	} );

	assert.ok( recreated() );
} );

test( 'startDatabase starts the tests database in its own container and data folder', async () => {
	const cli = fakeCLI( {
		containers: {
			'example-project-tests-mysql': {
				state: 'running',
				ipAddress: '192.168.64.10',
			},
		},
	} );
	const root = makeTempDir( 'wpec-test-' );
	const config = makeConfig( { stateDirectoryPath: root } );

	const host = await makeRuntime( cli ).startDatabase(
		config,
		'tests',
		new Set(),
		{ port: 13307 }
	);

	assert.equal( host, '192.168.64.10' );
	assert.ok( fs.existsSync( path.join( root, 'tests-mysql' ) ) );
	assert.deepEqual( cli.calls[ 0 ], [
		'delete',
		'--force',
		'example-project-tests-mysql',
	] );
	assert.ok( cli.calls[ 1 ].includes( 'example-project-tests-mysql' ) );
	assert.equal( cli.calls[ 2 ][ 1 ], 'example-project-tests-mysql' );
	assert.equal(
		cli.calls[ 3 ].at( -1 ),
		'CREATE DATABASE IF NOT EXISTS `tests-wordpress`'
	);
} );

test( 'startDatabase recreates a running database when asked', async () => {
	const { runtime, config, running, recreated } = databaseRuntime( {
		image: 'docker.io/library/mariadb:lts',
		ports: [
			{
				hostAddress: '127.0.0.1',
				hostPort: 13306,
				containerPort: 3306,
				proto: 'tcp',
			},
		],
	} );

	await runtime.startDatabase( config, 'development', running, {
		port: 13306,
	} );
	assert.equal( recreated(), false );

	await runtime.startDatabase( config, 'development', running, {
		recreate: true,
		port: 13306,
	} );
	assert.ok( recreated() );
} );

test( 'start deletes each WordPress container before running it', async () => {
	const root = makeTempDir( 'wpec-test-' );
	const config = makeConfig( { stateDirectoryPath: root } );
	fs.writeFileSync( path.join( root, 'config-hash' ), configHash( config ) );
	writeConfiguredState( config );

	const cli = fakeCLI();
	cli.listByLabels = async () => [
		runningRecord( 'example-project-wordpress' ),
	];
	const runtime = makeRuntime( cli );
	runtime.assertAvailable = async () => {};
	runtime.isPortFree = async () => true;
	runtime.pickRandomPort = async () => 50003;
	runtime.prepareImages = async () => {};
	runtime.preparePHPUnit = async () => {};
	runtime.startDatabase = async () => '192.168.64.9';
	runtime.waitForHTTP = async () => {};

	await runtime.start( config );

	const steps = cli.calls.map( ( args ) =>
		args[ 0 ] === 'run'
			? [ 'run', args[ args.indexOf( '--name' ) + 1 ] ]
			: args
	);
	assert.deepEqual( steps, [
		[ 'stop', 'example-project-wordpress' ],
		[ 'delete', '--force', 'example-project-wordpress' ],
		[ 'run', 'example-project-wordpress' ],
		[ 'delete', '--force', 'example-project-tests-wordpress' ],
		[ 'run', 'example-project-tests-wordpress' ],
	] );
} );

test( 'run loads Xdebug in a CLI container and points it at the host gateway', async () => {
	const cli = fakeCLI( { containers: RUNNING } );
	cli.hostGateway = async () => '192.168.64.1';
	const runtime = makeRuntime( cli );

	await withTTY( false, () =>
		runtime.run( lockedConfig(), {
			container: 'tests-cli',
			command: [ 'php', '-m' ],
			xdebug: true,
		} )
	);
	await withTTY( false, () =>
		runtime.run( lockedConfig(), {
			container: 'cli',
			command: [ 'php', '-m' ],
			xdebug: 'coverage,debug',
		} )
	);
	await withTTY( false, () =>
		runtime.run( lockedConfig(), {
			container: 'cli',
			command: [ 'php', '-m' ],
		} )
	);

	const environment = ( args ) =>
		args.flatMap( ( arg, index ) =>
			arg === '-e' ? [ args[ index + 1 ] ] : []
		);
	assert.ok( environment( cli.calls[ 0 ] ).includes( 'XDEBUG_MODE=debug' ) );
	assert.ok(
		environment( cli.calls[ 0 ] ).includes(
			'XDEBUG_CONFIG=client_host=192.168.64.1 client_port=9003'
		)
	);
	assert.ok(
		environment( cli.calls[ 1 ] ).includes( 'XDEBUG_MODE=coverage,debug' )
	);
	assert.ok(
		! environment( cli.calls[ 2 ] ).some( ( value ) =>
			value.startsWith( 'XDEBUG_' )
		)
	);
} );

test( 'run rejects Xdebug outside the CLI containers', async () => {
	const cli = fakeCLI( {
		containers: {
			...RUNNING,
			'example-project-wordpress': { state: 'running' },
		},
	} );
	const runtime = makeRuntime( cli );

	for ( const container of [ 'wordpress', 'tests-wordpress', 'mysql' ] ) {
		await assert.rejects(
			runtime.run( makeConfig(), {
				container,
				command: [ 'php', '-m' ],
				xdebug: true,
			} ),
			{ message: 'Xdebug is available in cli and tests-cli only.' }
		);
	}
	assert.equal( cli.calls.length, 0 );
} );

test( 'run rejects an invalid Xdebug mode and an old PHP version before starting a container', async () => {
	const cli = fakeCLI( { containers: RUNNING } );
	cli.hostGateway = async () => '192.168.64.1';
	const runtime = makeRuntime( cli );
	const config = makeConfig();
	config.env.development.phpVersion = '7.1';

	await assert.rejects(
		runtime.run( makeConfig(), {
			container: 'cli',
			command: [ 'php' ],
			xdebug: 'bogus',
		} ),
		/Invalid Xdebug mode "bogus"/
	);
	await assert.rejects(
		runtime.run( config, {
			container: 'cli',
			command: [ 'php' ],
			xdebug: true,
		} ),
		{
			message:
				'Xdebug needs PHP 7.2 or later; the development environment uses PHP 7.1.',
		}
	);
	assert.equal( cli.calls.length, 0 );
} );

test( 'phpunit forwards xdebug to its CLI container', async () => {
	const root = makeTempDir( 'wpec-test-' );
	const config = makeConfig( {
		stateDirectoryPath: path.join( root, 'state' ),
	} );
	const cli = fakeCLI( { containers: RUNNING } );
	cli.hostGateway = async () => '192.168.64.1';

	await makeRuntime( cli ).phpunit( config, { xdebug: 'coverage' } );

	assert.ok( cli.calls[ 0 ].includes( 'XDEBUG_MODE=coverage' ) );
	assert.ok(
		cli.calls[ 0 ].includes(
			'PHP_INI_SCAN_DIR=:/usr/local/etc/php/conf.d-xdebug'
		)
	);
} );

test( 'a CLI image build removes the outdated images of the same PHP version', async () => {
	const root = makeTempDir( 'wpec-test-' );
	const config = makeConfig( { stateDirectoryPath: root } );
	const current = recipes.cliImage( '8.3' );
	const cli = fakeCLI();
	cli.listImages = async () => [
		'wp-env-container/cli:php8.3',
		'wp-env-container/cli:php8.3-0123abcd',
		current,
		'wp-env-container/cli:php8.2-0123abcd',
		'wp-env-container/cli:latest',
		'docker.io/library/wordpress:cli-php8.3',
	];

	await makeRuntime( cli ).buildImages( config, [
		recipes.localImage( 'cli', '8.3' ),
	] );

	assert.equal( cli.calls[ 0 ][ 0 ], 'build' );
	assert.equal(
		cli.calls[ 0 ][ cli.calls[ 0 ].indexOf( '-t' ) + 1 ],
		current
	);
	assert.deepEqual( cli.calls[ 1 ], [
		'image',
		'delete',
		'wp-env-container/cli:php8.3',
		'wp-env-container/cli:php8.3-0123abcd',
	] );
} );

test( 'a failed removal of outdated CLI images does not fail the build', async () => {
	const root = makeTempDir( 'wpec-test-' );
	const config = makeConfig( { stateDirectoryPath: root } );
	const messages = [];
	const failingList = fakeCLI();
	failingList.listImages = async () => {
		throw new Error( 'list failed' );
	};
	const failingDelete = fakeCLI( {
		onExec: async () => ( {
			exitCode: 1,
			stdout: '',
			stderr: 'busy',
			timedOut: false,
		} ),
	} );
	failingDelete.listImages = async () => [ 'wp-env-container/cli:php8.3' ];

	for ( const cli of [ failingList, failingDelete ] ) {
		const runtime = new AppleContainerRuntime( {
			cli,
			log: ( message ) => messages.push( message ),
		} );
		await runtime.buildImages( config, [
			recipes.localImage( 'cli', '8.3' ),
		] );
	}

	assert.ok(
		messages.includes( 'Could not remove outdated images: list failed' )
	);
	assert.ok( messages.includes( 'Could not remove outdated images: busy' ) );
} );

function projectState() {
	const dir = makeTempDir( 'wpec-runtime-' );
	fs.writeFileSync( path.join( dir, 'marker' ), 'x' );
	return dir;
}

test( 'cleanup stops the project containers and removes the state directory', async () => {
	const stateDirectoryPath = projectState();
	const cli = fakeCLI();
	cli.listByLabels = async () => [
		{ name: 'example-project-mysql', state: 'running' },
	];

	await makeRuntime( cli ).cleanup( makeConfig( { stateDirectoryPath } ) );

	assert.ok(
		cli.calls.some(
			( args ) =>
				args[ 0 ] === 'stop' && args.includes( 'example-project-mysql' )
		)
	);
	assert.equal(
		cli.calls.some( ( args ) => args[ 0 ] === 'image' ),
		false
	);
	assert.equal( fs.existsSync( stateDirectoryPath ), false );
} );

test( 'destroy deletes the project images and skips one another container uses', async () => {
	const stateDirectoryPath = projectState();
	const cli = fakeCLI();
	cli.listByLabels = async () => [];
	cli.imageExists = async () => true;
	cli.list = async () => [
		{
			name: 'other-db',
			state: 'stopped',
			image: 'docker.io/library/mariadb:lts',
		},
	];
	const config = makeConfig( {
		stateDirectoryPath,
		mariadbImage: 'mariadb:lts',
	} );

	await makeRuntime( cli ).destroy( config );

	const deleted = cli.calls
		.filter( ( args ) => args[ 0 ] === 'image' && args[ 1 ] === 'delete' )
		.map( ( args ) => args[ 2 ] );
	assert.ok( deleted.includes( 'wordpress:latest' ) );
	assert.ok( deleted.includes( recipes.cliImage( null ) ) );
	assert.ok( deleted.includes( recipes.xdebugWordPressImage( null ) ) );
	assert.equal( deleted.includes( 'mariadb:lts' ), false );
	assert.equal( new Set( deleted ).size, deleted.length );
	assert.equal( fs.existsSync( stateDirectoryPath ), false );
} );

test( 'destroy does not throw when an image cannot be deleted', async () => {
	const stateDirectoryPath = projectState();
	const logs = [];
	const cli = fakeCLI( {
		onExec: async ( args ) =>
			args[ 0 ] === 'image'
				? { exitCode: 1, stdout: '', stderr: 'in use', timedOut: false }
				: { exitCode: 0, stdout: '', stderr: '', timedOut: false },
	} );
	cli.listByLabels = async () => [];
	cli.list = async () => [];
	const runtime = new AppleContainerRuntime( {
		cli,
		log: ( message ) => logs.push( message ),
	} );

	await runtime.destroy( makeConfig( { stateDirectoryPath } ) );

	assert.ok(
		logs.some( ( message ) =>
			/Could not remove wordpress:latest: in use/.test( message )
		)
	);
	assert.equal(
		logs.some( ( message ) =>
			message.includes( 'wp-env-container/wordpress:' )
		),
		false,
		'an Xdebug web image that was never built is skipped'
	);
} );

test( 'cleanup succeeds when the state directory and lock vanish inside the locked section', async () => {
	const stateDirectoryPath = projectState();
	const cli = fakeCLI();
	cli.listByLabels = async () => [];
	const runtime = makeRuntime( cli );
	runtime.removeStateDirectory = async () => {
		fs.rmSync( stateDirectoryPath, { recursive: true, force: true } );
	};

	await runtime.cleanup( makeConfig( { stateDirectoryPath } ) );

	assert.equal( fs.existsSync( stateDirectoryPath ), false );
} );

test( 'cleanup removes the lock file with the state directory', async () => {
	const stateDirectoryPath = projectState();
	const cli = fakeCLI();
	cli.listByLabels = async () => [];

	await makeRuntime( cli ).cleanup( makeConfig( { stateDirectoryPath } ) );

	assert.equal(
		fs.existsSync( path.join( stateDirectoryPath, '.lock' ) ),
		false
	);
	assert.equal( fs.existsSync( stateDirectoryPath ), false );
} );

test( 'builder status distinguishes running, stopped and a missing builder', async () => {
	const answers = [
		[ { status: 'running', configuration: { id: 'buildkit' } }, true ],
		[
			{ status: { state: 'running' }, configuration: { id: 'buildkit' } },
			true,
		],
		[ { status: 'stopped', configuration: { id: 'buildkit' } }, false ],
	];
	for ( const [ record, expected ] of answers ) {
		const cli = fakeCLI( {
			onExec: async () => ( {
				exitCode: 0,
				stdout: JSON.stringify( [ record ] ),
				stderr: '',
				timedOut: false,
			} ),
		} );
		assert.equal( await makeRuntime( cli ).isBuilderRunning(), expected );
		assert.deepEqual( cli.calls[ 0 ], [
			'builder',
			'status',
			'--format',
			'json',
		] );
	}

	for ( const stdout of [ 'builder is not running', '', '[]' ] ) {
		const cli = fakeCLI( {
			onExec: async () => ( {
				exitCode: 0,
				stdout,
				stderr: '',
				timedOut: false,
			} ),
		} );
		assert.equal(
			await makeRuntime( cli ).isBuilderRunning(),
			false,
			stdout
		);
	}
} );

test( 'a CLI image build keeps outdated images that a container still uses', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const current = recipes.cliImage( '8.3' );
	const cli = fakeCLI();
	cli.listImages = async () => [
		'wp-env-container/cli:php8.3',
		'wp-env-container/cli:php8.3-0123abcd',
		current,
	];
	cli.list = async () => [
		{
			name: 'old-cli',
			state: 'stopped',
			image: 'wp-env-container/cli:php8.3',
		},
	];

	await makeRuntime( cli ).buildImages( config, [
		recipes.localImage( 'cli', '8.3' ),
	] );

	assert.deepEqual( cli.calls[ 1 ], [
		'image',
		'delete',
		'wp-env-container/cli:php8.3-0123abcd',
	] );
} );

test( 'configureWordPress quotes names and values as single shell words', async () => {
	const cli = fakeCLI();
	const config = makeConfig( { name: "Bob's $HOME (v2)" } );
	config.env.tests.pluginSources = [
		{
			type: 'local',
			path: '/projects/my plugin',
			basename: 'My Plugin (v2)',
		},
	];
	config.env.tests.config.WP_TESTS_TITLE = 'Say "hi" `now`';

	await makeRuntime( cli ).configureWordPress(
		config,
		'tests',
		'192.168.64.9'
	);

	const call = cli.calls.find( ( args ) => args.includes( 'bash' ) );
	const script = call[ call.indexOf( '-c' ) + 1 ];
	assert.match( script, /--title='Bob'\\''s \$HOME \(v2\)'/ );
	assert.match( script, /wp plugin activate 'My Plugin \(v2\)'/ );
	assert.match(
		script,
		/wp config set 'WP_TESTS_TITLE' 'Say "hi" `now`' --anchor=/
	);
	assert.match(
		script,
		/wp config set 'WP_DEBUG' 'true' --anchor="define\( 'WP_DEBUG'," --raw/
	);
} );

test( 'configureWordPress points the stored URLs of a single site at its port', async () => {
	const cli = fakeCLI();
	const config = makeConfig();

	await makeRuntime( cli ).configureWordPress(
		recipes.withWordPressPort( config, 'tests', 8895 ),
		'tests',
		'192.168.64.10'
	);
	config.env.development.multisite = true;
	await makeRuntime( cli ).configureWordPress(
		config,
		'development',
		'192.168.64.9'
	);

	const [ single, multisite ] = cli.calls.map(
		( args ) => args[ args.indexOf( '-c' ) + 1 ]
	);
	assert.match(
		single,
		/wp config delete WP_SITEURL 2> \/dev\/null \|\| true; } && \{ wp config delete WP_HOME 2> \/dev\/null \|\| true; } && wp option update siteurl 'http:\/\/localhost:8895' && wp option update home 'http:\/\/localhost:8895' && wp config set 'WP_DEBUG'/
	);
	assert.match(
		single,
		/wp config set 'WP_SITEURL' 'http:\/\/localhost:8895' --anchor=/
	);
	assert.doesNotMatch( multisite, /wp option update/ );
} );

// Host ports `runningRecord` publishes, by container name.
const PUBLISHED_PORTS = {
	'example-project-wordpress': [ 8888, 80 ],
	'example-project-tests-wordpress': [ 8889, 80 ],
	'example-project-mysql': [ 50001, 3306 ],
	'example-project-tests-mysql': [ 50002, 3306 ],
	'example-project-phpmyadmin': [ 50011, 80 ],
	'example-project-tests-phpmyadmin': [ 50012, 80 ],
};

/**
 * Saves the environment state of a configured project: the database folders,
 * the MariaDB ports `runningRecord` publishes and the site URLs of `config`.
 *
 * @param {Object} config Project configuration; its state folder must exist.
 */
function writeConfiguredState( config ) {
	const state = {};
	for ( const env of [ 'development', 'tests' ] ) {
		const prefix = env === 'tests' ? 'tests-' : '';
		fs.mkdirSync(
			path.join( config.stateDirectoryPath, `${ prefix }mysql` ),
			{
				recursive: true,
			}
		);
		state[ env ] = {
			mysql: PUBLISHED_PORTS[ `example-project-${ prefix }mysql` ][ 0 ],
			siteUrl: config.env[ env ].config.WP_SITEURL,
		};
		if ( config.env[ env ].phpmyadmin ) {
			state[ env ].phpmyadmin =
				PUBLISHED_PORTS[ `example-project-${ prefix }phpmyadmin` ][ 0 ];
		}
	}
	fs.writeFileSync(
		path.join( config.stateDirectoryPath, 'environments.json' ),
		JSON.stringify( state )
	);
}

/**
 * A runtime whose `start` skips availability checks, images, sources,
 * PHPUnit and HTTP waits, with a saved config hash and environment state so
 * WordPress is not reconfigured. `runtime.databaseStarts` records the
 * options of each `startDatabase` call.
 *
 * @param {Object}   options
 * @param {Object}   options.config        Project configuration; its state folder must exist.
 * @param {Object[]} options.containers    Project container records `listByLabels` returns.
 * @param {Object}   [options.savedConfig] Configuration the saved hash and state come from; `config` by default.
 * @return {{cli: Object, runtime: AppleContainerRuntime, logs: string[]}} The runtime, its fake CLI and the logged messages.
 */
function startRuntime( { config, containers, savedConfig = config } ) {
	fs.writeFileSync(
		path.join( config.stateDirectoryPath, 'config-hash' ),
		configHash( savedConfig )
	);
	writeConfiguredState( {
		...savedConfig,
		stateDirectoryPath: config.stateDirectoryPath,
	} );
	const byName = Object.fromEntries(
		containers.map( ( record ) => [ record.name, record ] )
	);
	const cli = fakeCLI( { containers: byName } );
	cli.listByLabels = async () =>
		containers.filter(
			( record ) =>
				! cli.calls.some(
					( args ) =>
						args[ 0 ] === 'delete' && args.includes( record.name )
				)
		);
	cli.hostGateway = async () => '192.168.64.1';
	const logs = [];
	const runtime = new AppleContainerRuntime( {
		cli,
		log: ( message ) => logs.push( message ),
	} );
	runtime.assertAvailable = async () => {};
	runtime.isPortFree = async () => true;
	runtime.pickRandomPort = async () => 50003;
	runtime.prepareImages = async ( ...args ) => {
		runtime.imageRequests.push( args[ 2 ] );
	};
	runtime.imageRequests = [];
	runtime.preparePHPUnit = async () => {};
	runtime.databaseStarts = [];
	runtime.startDatabase = async ( _config, env, _running, options ) => {
		runtime.databaseStarts.push( { env, ...options } );
		return '192.168.64.9';
	};
	runtime.waitForHTTP = async () => {};
	runtime.configureWordPress = async () => {
		throw new Error( 'WordPress is not reconfigured' );
	};
	return { cli, runtime, logs };
}

const runningRecord = ( name, labels = {} ) => ( {
	name,
	state: 'running',
	labels: { 'dev.wp-env-container.project': 'example-project', ...labels },
	ports: [
		{
			hostAddress:
				PUBLISHED_PORTS[ name ][ 1 ] === 80 &&
				! name.endsWith( 'phpmyadmin' )
					? '0.0.0.0'
					: '127.0.0.1',
			hostPort: PUBLISHED_PORTS[ name ][ 0 ],
			containerPort: PUBLISHED_PORTS[ name ][ 1 ],
			proto: 'tcp',
		},
	],
} );

test( 'start stops and deletes the tests web container when testsEnvironment is false', async () => {
	const root = makeTempDir( 'wpec-test-' );
	fs.mkdirSync( path.join( root, 'tests-WordPress' ) );
	const config = makeConfig( {
		stateDirectoryPath: root,
		testsEnvironment: false,
	} );
	const { cli, runtime } = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-mysql' ),
			runningRecord( 'example-project-wordpress' ),
			runningRecord( 'example-project-tests-wordpress' ),
		],
	} );

	await runtime.start( config );

	assert.deepEqual( cli.calls.slice( 0, 2 ), [
		[ 'stop', 'example-project-tests-wordpress' ],
		[ 'delete', '--force', 'example-project-tests-wordpress' ],
	] );
	assert.equal(
		cli.calls.some(
			( args ) =>
				args[ 0 ] === 'run' &&
				args.includes( 'example-project-tests-wordpress' )
		),
		false
	);
	assert.ok( fs.existsSync( path.join( root, 'tests-WordPress' ) ) );
} );

test( 'start deletes a stopped tests web container when testsEnvironment is false', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
		testsEnvironment: false,
	} );
	const { cli, runtime } = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-mysql' ),
			runningRecord( 'example-project-wordpress' ),
			{
				...runningRecord( 'example-project-tests-wordpress' ),
				state: 'stopped',
			},
		],
	} );

	await runtime.start( config );

	assert.deepEqual( cli.calls, [
		[ 'delete', '--force', 'example-project-tests-wordpress' ],
	] );
} );

test( 'start leaves the tests web container alone when the tests environment is enabled', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const { cli, runtime, logs } = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-mysql' ),
			runningRecord( 'example-project-tests-mysql' ),
			runningRecord( 'example-project-wordpress' ),
			runningRecord( 'example-project-tests-wordpress' ),
		],
	} );

	await runtime.start( config );

	assert.deepEqual( cli.calls, [] );
	assert.deepEqual( logs, [ 'Environment already running.' ] );
} );

test( 'start recreates the web containers when the Xdebug modes change', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const containers = [
		runningRecord( 'example-project-mysql' ),
		runningRecord( 'example-project-tests-mysql' ),
		runningRecord( 'example-project-wordpress' ),
		runningRecord( 'example-project-tests-wordpress' ),
	];
	const { cli, runtime } = startRuntime( { config, containers } );

	await runtime.start( config, { xdebug: true } );

	const runs = cli.calls.filter( ( args ) => args[ 0 ] === 'run' );
	assert.equal( runs.length, 2 );
	for ( const args of runs ) {
		assert.ok( args.includes( 'dev.wp-env-container.xdebug=debug' ) );
		assert.ok(
			args.includes( 'WP_ENV_CONTAINER_XDEBUG_CLIENT_HOST=192.168.64.1' )
		);
		assert.equal( args.at( -1 ), recipes.xdebugWordPressImage( null ) );
	}
	assert.deepEqual( runtime.imageRequests, [
		{ update: false, xdebug: true },
	] );
} );

test( 'start turns Xdebug off when the flag is left out', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const xdebug = { 'dev.wp-env-container.xdebug': 'debug' };
	const { cli, runtime } = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-mysql' ),
			runningRecord( 'example-project-tests-mysql' ),
			runningRecord( 'example-project-wordpress', xdebug ),
			runningRecord( 'example-project-tests-wordpress', xdebug ),
		],
	} );

	await runtime.start( config );

	const runs = cli.calls.filter( ( args ) => args[ 0 ] === 'run' );
	assert.equal( runs.length, 2 );
	for ( const args of runs ) {
		assert.equal( args.at( -1 ), 'wordpress:latest' );
		assert.equal(
			args.some( ( arg ) =>
				arg.startsWith( 'dev.wp-env-container.xdebug' )
			),
			false
		);
	}
} );

test( 'start keeps running web containers whose Xdebug modes match', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const xdebug = { 'dev.wp-env-container.xdebug': 'debug,profile' };
	const { cli, runtime, logs } = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-mysql' ),
			runningRecord( 'example-project-tests-mysql' ),
			runningRecord( 'example-project-wordpress', xdebug ),
			runningRecord( 'example-project-tests-wordpress', xdebug ),
		],
	} );

	await runtime.start( config, { xdebug: 'debug,profile' } );

	assert.deepEqual( cli.calls, [] );
	assert.deepEqual( logs, [ 'Environment already running.' ] );
} );

test( 'start rejects an invalid Xdebug mode and an old PHP version before touching containers', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const { cli, runtime } = startRuntime( { config, containers: [] } );
	let checkedAvailability = false;
	runtime.assertAvailable = async () => {
		checkedAvailability = true;
	};

	await assert.rejects(
		runtime.start( config, { xdebug: 'bogus' } ),
		/Invalid Xdebug mode "bogus"/
	);
	config.env.tests.phpVersion = '7.1';
	await assert.rejects( runtime.start( config, { xdebug: true } ), {
		message:
			'Xdebug needs PHP 7.2 or later; the tests environment uses PHP 7.1.',
	} );
	assert.equal( checkedAvailability, false );
	assert.deepEqual( cli.calls, [] );
} );

test( 'prepareImages builds the web Xdebug image only when Xdebug is on', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const cli = fakeCLI();
	cli.imageExists = async ( reference ) =>
		! reference.startsWith( 'wp-env-container/wordpress:' );
	const runtime = makeRuntime( cli );
	const builds = [];
	runtime.buildImages = async ( _config, images ) => {
		builds.push( images.map( ( image ) => image.tag ) );
	};

	await runtime.prepareImages( config, [ 'development', 'tests' ], {
		update: false,
	} );
	await runtime.prepareImages( config, [ 'development', 'tests' ], {
		update: false,
		xdebug: true,
	} );

	assert.deepEqual( builds, [ [ recipes.xdebugWordPressImage( null ) ] ] );
	assert.deepEqual(
		cli.calls.filter( ( args ) => args[ 0 ] === 'builder' ),
		[
			[ 'builder', 'status', '--format', 'json' ],
			[ 'builder', 'stop' ],
		]
	);
} );

test( 'a web Xdebug image build removes the outdated web images of the same PHP version only', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const image = recipes.localImage( 'wordpress', '8.3' );
	const cli = fakeCLI();
	cli.listImages = async () => [
		'wp-env-container/wordpress:php8.3-0123abcd',
		image.tag,
		'wp-env-container/wordpress:php8.2-0123abcd',
		'wp-env-container/cli:php8.3-0123abcd',
	];

	await makeRuntime( cli ).buildImages( config, [ image ] );

	assert.equal(
		fs.readFileSync(
			path.join(
				config.stateDirectoryPath,
				'build',
				image.tag.replace( /[/:]/g, '-' ),
				'Containerfile'
			),
			'utf8'
		),
		recipes.xdebugWordPressContainerfile( '8.3' )
	);
	assert.deepEqual( cli.calls[ 1 ], [
		'image',
		'delete',
		'wp-env-container/wordpress:php8.3-0123abcd',
	] );
} );

test( 'prepareCore copies a shared core source into the tests core folder only', async () => {
	const root = makeTempDir( 'wpec-test-' );
	const config = makeConfig( { stateDirectoryPath: root } );
	const cli = fakeCLI();
	const copyCore = sources.copyCore;
	const copies = [];
	sources.copyCore = async ( from, to ) => copies.push( [ from, to ] );
	try {
		await makeRuntime( cli ).prepareCore( config, [
			'development',
			'tests',
		] );
	} finally {
		sources.copyCore = copyCore;
	}

	assert.deepEqual( copies, [
		[
			'/state/example-project/WordPress',
			'/state/example-project/tests-WordPress',
		],
	] );
	assert.deepEqual( cli.calls, [] );
} );

test( 'getStatus reports the web Xdebug modes, or off', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const cli = fakeCLI();
	cli.listByLabels = async () => [
		runningRecord( 'example-project-wordpress', {
			'dev.wp-env-container.xdebug': 'debug,coverage',
		} ),
		runningRecord( 'example-project-tests-wordpress' ),
	];

	const status = await makeRuntime( cli ).getStatus( config );

	assert.equal( status.environments.development.xdebug, 'debug,coverage' );
	assert.equal( status.environments.tests.xdebug, 'off' );
	assert.equal(
		status.environments.development.image,
		recipes.xdebugWordPressImage( null )
	);
	assert.equal( status.environments.tests.image, 'wordpress:latest' );
} );

test( 'start moves a busy WordPress port with autoPort and reconfigures that site', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
		autoPort: true,
	} );
	const { cli, runtime } = startRuntime( { config, containers: [] } );
	runtime.isPortFree = async ( port ) => port !== 8888;
	const configured = [];
	runtime.configureWordPress = async ( started, env ) =>
		configured.push( [ env, started.env[ env ].config.WP_SITEURL ] );

	const urls = await runtime.start( config );

	assert.deepEqual( urls, {
		siteUrl: 'http://localhost:8889',
		testsUrl: 'http://localhost:8890',
		phpmyadminUrl: null,
		testsPhpmyadminUrl: null,
	} );
	const published = cli.calls
		.filter( ( args ) => args[ 0 ] === 'run' )
		.map( ( args ) => args[ args.indexOf( '-p' ) + 1 ] );
	assert.deepEqual( published, [ '0.0.0.0:8889:80', '0.0.0.0:8890:80' ] );
	assert.deepEqual( configured, [
		[ 'development', 'http://localhost:8889' ],
		[ 'tests', 'http://localhost:8890' ],
	] );
	const state = JSON.parse(
		fs.readFileSync(
			path.join( config.stateDirectoryPath, 'environments.json' ),
			'utf8'
		)
	);
	assert.equal( state.development.siteUrl, 'http://localhost:8889' );
	assert.equal( state.tests.siteUrl, 'http://localhost:8890' );
} );

test( 'start rejects a busy WordPress port without autoPort, and when CI is set', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const { cli, runtime } = startRuntime( { config, containers: [] } );
	runtime.isPortFree = async ( port ) => port !== 8888;
	const busy = /^Port 8888 \(development\) is already in use\./;

	await assert.rejects( runtime.start( config ), { message: busy } );
	await assert.rejects( runtime.start( config, { autoPort: false } ), {
		message: busy,
	} );
	process.env.CI = 'true';
	try {
		await assert.rejects( runtime.start( config, { autoPort: true } ), {
			message: busy,
		} );
	} finally {
		delete process.env.CI;
	}
	assert.deepEqual( cli.calls, [] );
} );

test( 'start --no-auto-port overrides "autoPort": true', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
		autoPort: true,
	} );
	const { runtime } = startRuntime( { config, containers: [] } );
	runtime.isPortFree = async ( port ) => port !== 8888;

	await assert.rejects( runtime.start( config, { autoPort: false } ), {
		message: /^Port 8888 \(development\) is already in use\./,
	} );
} );

test( 'start keeps a running environment on its moved ports', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
		autoPort: true,
	} );
	const moved = {
		...runningRecord( 'example-project-wordpress' ),
		ports: [
			{ hostAddress: '0.0.0.0', hostPort: 8895, containerPort: 80 },
		],
	};
	const { cli, runtime, logs } = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-mysql' ),
			runningRecord( 'example-project-tests-mysql' ),
			moved,
			runningRecord( 'example-project-tests-wordpress' ),
		],
	} );
	const state = JSON.parse(
		fs.readFileSync(
			path.join( config.stateDirectoryPath, 'environments.json' ),
			'utf8'
		)
	);
	state.development.siteUrl = 'http://localhost:8895';
	fs.writeFileSync(
		path.join( config.stateDirectoryPath, 'environments.json' ),
		JSON.stringify( state )
	);
	runtime.isPortFree = async () => false;

	const urls = await runtime.start( config );

	assert.deepEqual( cli.calls, [] );
	assert.deepEqual( logs, [ 'Environment already running.' ] );
	assert.equal( urls.siteUrl, 'http://localhost:8895' );
} );

test( 'start gives each database its own port and reuses the saved one', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const { runtime } = startRuntime( { config, containers: [] } );
	runtime.isPortFree = async ( port ) => port !== 50002;
	runtime.pickRandomPort = async () => 50040;
	const databases = [];
	runtime.startDatabase = async ( _config, env, _running, options ) => {
		databases.push( [ env, options.port ] );
		return env === 'tests' ? '192.168.64.10' : '192.168.64.9';
	};

	await runtime.start( config );

	assert.deepEqual( databases, [
		[ 'development', 50001 ],
		[ 'tests', 50040 ],
	] );
	const state = JSON.parse(
		fs.readFileSync(
			path.join( config.stateDirectoryPath, 'environments.json' ),
			'utf8'
		)
	);
	assert.equal( state.tests.mysql, 50040 );
} );

test( 'start points each WordPress container at its own database', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const { cli, runtime } = startRuntime( { config, containers: [] } );
	runtime.startDatabase = async ( _config, env ) =>
		env === 'tests' ? '192.168.64.10' : '192.168.64.9';

	await runtime.start( config );

	const runs = cli.calls.filter( ( args ) => args[ 0 ] === 'run' );
	assert.ok( runs[ 0 ].includes( 'WORDPRESS_DB_HOST=192.168.64.9' ) );
	assert.ok( runs[ 1 ].includes( 'WORDPRESS_DB_HOST=192.168.64.10' ) );
} );

test( 'start configures the tests site when its database folder is new', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const { runtime } = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-mysql' ),
			runningRecord( 'example-project-wordpress' ),
			runningRecord( 'example-project-tests-wordpress' ),
		],
	} );
	fs.rmSync( path.join( config.stateDirectoryPath, 'tests-mysql' ), {
		recursive: true,
	} );
	const configured = [];
	runtime.configureWordPress = async ( _config, env ) =>
		configured.push( env );

	await runtime.start( config );

	assert.deepEqual( configured, [ 'tests' ] );
} );

test( 'start removes the tests database container when testsEnvironment is false', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
		testsEnvironment: false,
	} );
	const { cli, runtime } = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-mysql' ),
			runningRecord( 'example-project-tests-mysql' ),
			runningRecord( 'example-project-wordpress' ),
		],
	} );

	await runtime.start( config );

	assert.deepEqual( cli.calls, [
		[ 'stop', 'example-project-tests-mysql' ],
		[ 'delete', '--force', 'example-project-tests-mysql' ],
	] );
} );

test( 'getStatus reports the published ports and the database of each environment', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const cli = fakeCLI();
	cli.listByLabels = async () => [
		{
			...runningRecord( 'example-project-wordpress' ),
			ports: [ { hostPort: 8895, containerPort: 80 } ],
		},
		{
			...runningRecord( 'example-project-tests-mysql' ),
			ipAddress: '192.168.64.10',
		},
	];

	const status = await makeRuntime( cli ).getStatus( config );

	assert.equal(
		status.environments.development.url,
		'http://localhost:8895'
	);
	assert.equal( status.environments.development.port, 8895 );
	assert.deepEqual( status.environments.development.database, {
		running: false,
		container: 'example-project-mysql',
		host: null,
		port: null,
		image: 'mariadb:lts',
	} );
	assert.equal( status.environments.tests.url, 'http://localhost:8889' );
	assert.deepEqual( status.environments.tests.database, {
		running: true,
		container: 'example-project-tests-mysql',
		host: '192.168.64.10',
		port: 50002,
		image: 'mariadb:lts',
	} );
	assert.equal( status.database, undefined );
} );

/**
 * Saves `siteUrl` as the URL the development site was last configured with.
 *
 * @param {Object} config  Project configuration; its state file must exist.
 * @param {string} siteUrl URL to save.
 */
function saveDevelopmentSiteUrl( config, siteUrl ) {
	const statePath = path.join(
		config.stateDirectoryPath,
		'environments.json'
	);
	const state = JSON.parse( fs.readFileSync( statePath, 'utf8' ) );
	state.development.siteUrl = siteUrl;
	fs.writeFileSync( statePath, JSON.stringify( state ) );
}

test( 'start honours a changed WordPress port with autoPort when it is free', async () => {
	const config = recipes.withWordPressPort(
		makeConfig( {
			stateDirectoryPath: makeTempDir( 'wpec-test-' ),
			autoPort: true,
		} ),
		'development',
		8935
	);
	const { cli, runtime } = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-mysql' ),
			runningRecord( 'example-project-tests-mysql' ),
			runningRecord( 'example-project-wordpress' ),
			runningRecord( 'example-project-tests-wordpress' ),
		],
	} );
	saveDevelopmentSiteUrl( config, 'http://localhost:8888' );
	runtime.isPortFree = async ( port ) =>
		! Object.values( PUBLISHED_PORTS ).some(
			( [ host ] ) => host === port
		);
	const configured = [];
	runtime.configureWordPress = async ( started, env ) =>
		configured.push( [ env, started.env[ env ].config.WP_SITEURL ] );

	const urls = await runtime.start( config );

	assert.equal( urls.siteUrl, 'http://localhost:8935' );
	assert.ok(
		cli.calls.some(
			( args ) =>
				args[ 0 ] === 'run' && args.includes( '0.0.0.0:8935:80' )
		)
	);
	assert.deepEqual( configured, [
		[ 'development', 'http://localhost:8935' ],
	] );
} );

test( 'start gives the tests database its own port when "mysqlPort" is set at the root', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	config.env.development.mysqlPort = 13306;
	config.env.tests.mysqlPort = 13306;
	const { runtime, logs } = startRuntime( { config, containers: [] } );
	const databases = [];
	runtime.startDatabase = async ( _config, env, _running, options ) => {
		databases.push( [ env, options.port ] );
		return env === 'tests' ? '192.168.64.10' : '192.168.64.9';
	};

	await runtime.start( config );

	assert.deepEqual( databases, [
		[ 'development', 13306 ],
		[ 'tests', 50002 ],
	] );
	assert.ok(
		logs.includes(
			'Tests database uses port 50002; "mysqlPort" 13306 belongs to the development database.'
		)
	);
} );

test( 'start stops the web containers before it recreates the databases', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const { cli, runtime } = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-mysql' ),
			runningRecord( 'example-project-tests-mysql' ),
			runningRecord( 'example-project-wordpress' ),
			runningRecord( 'example-project-tests-wordpress' ),
		],
	} );
	runtime.startDatabase = async ( _config, env ) => {
		cli.calls.push( [ 'startDatabase', env ] );
		if ( env === 'tests' ) {
			throw new Error( 'The tests database did not start.' );
		}
		return '192.168.64.9';
	};

	await assert.rejects( runtime.start( config, { xdebug: true } ), {
		message: 'The tests database did not start.',
	} );

	assert.deepEqual( cli.calls, [
		[
			'stop',
			'example-project-wordpress',
			'example-project-tests-wordpress',
		],
		[ 'startDatabase', 'development' ],
		[ 'startDatabase', 'tests' ],
	] );
} );

test( 'start moves a multisite network along with its WordPress port', async () => {
	const base = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	base.env.development.multisite = true;
	const config = recipes.withWordPressPort( base, 'development', 8936 );
	const { runtime } = startRuntime( { config, containers: [] } );
	saveDevelopmentSiteUrl( config, 'http://localhost:8888' );
	const configured = [];
	runtime.configureWordPress = async ( _started, env, _dbHost, options ) =>
		configured.push( [ env, options ] );

	await runtime.start( config );

	assert.deepEqual( configured, [
		[
			'development',
			{ previousUrl: 'http://localhost:8888', freshInstall: false },
		],
	] );
	const state = JSON.parse(
		fs.readFileSync(
			path.join( config.stateDirectoryPath, 'environments.json' ),
			'utf8'
		)
	);
	assert.equal( state.development.siteUrl, 'http://localhost:8936' );
} );

test( 'configureWordPress rewrites the network URLs of a moved multisite', async () => {
	const cli = fakeCLI();
	const config = makeConfig();
	config.env.development.multisite = true;
	const runtime = makeRuntime( cli );

	await runtime.configureWordPress(
		recipes.withWordPressPort( config, 'development', 8936 ),
		'development',
		'192.168.64.9',
		{ previousUrl: "http://localhost:8888/it's" }
	);
	await runtime.configureWordPress( config, 'development', '192.168.64.9', {
		previousUrl: 'http://localhost:8888',
	} );

	const [ moved, unchanged ] = cli.calls.map(
		( args ) => args[ args.indexOf( '-c' ) + 1 ]
	);
	assert.match(
		moved,
		/ && \{ wp config delete WP_SITEURL 2> \/dev\/null \|\| true; } && \{ wp config delete WP_HOME 2> \/dev\/null \|\| true; } && wp search-replace 'localhost:8888' 'localhost:8936' --network --all-tables-with-prefix --url='http:\/\/localhost:8888\/it'\\''s' && if wp config has DOMAIN_CURRENT_SITE; then wp config set DOMAIN_CURRENT_SITE 'localhost:8936'; fi && wp core multisite-install /
	);
	assert.doesNotMatch( unchanged, /search-replace|DOMAIN_CURRENT_SITE/ );
	assert.match(
		unchanged,
		/ && \{ wp config delete WP_HOME 2> \/dev\/null \|\| true; } && wp core multisite-install /
	);
} );

test( 'start compares Xdebug modes in any order and without repeats', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const xdebug = { 'dev.wp-env-container.xdebug': 'debug,develop' };
	const { cli, runtime, logs } = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-mysql' ),
			runningRecord( 'example-project-tests-mysql' ),
			runningRecord( 'example-project-wordpress', xdebug ),
			runningRecord( 'example-project-tests-wordpress', xdebug ),
		],
	} );

	await runtime.start( config, { xdebug: 'develop,debug,develop' } );

	assert.deepEqual( cli.calls, [] );
	assert.deepEqual( logs, [ 'Environment already running.' ] );
} );

test( 'start with Xdebug mode off runs the stock web image', async () => {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	config.env.tests.phpVersion = '7.1';
	const containers = [
		runningRecord( 'example-project-mysql' ),
		runningRecord( 'example-project-tests-mysql' ),
		runningRecord( 'example-project-wordpress' ),
		runningRecord( 'example-project-tests-wordpress' ),
	];
	const plain = startRuntime( { config, containers } );

	await plain.runtime.start( config, { xdebug: 'off' } );

	assert.deepEqual( plain.cli.calls, [] );
	assert.deepEqual( plain.logs, [ 'Environment already running.' ] );

	const xdebug = { 'dev.wp-env-container.xdebug': 'off' };
	const labelled = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-mysql' ),
			runningRecord( 'example-project-tests-mysql' ),
			runningRecord( 'example-project-wordpress', xdebug ),
			runningRecord( 'example-project-tests-wordpress', xdebug ),
		],
	} );

	await labelled.runtime.start( config, { xdebug: 'off' } );

	const runs = labelled.cli.calls.filter( ( args ) => args[ 0 ] === 'run' );
	assert.deepEqual(
		runs.map( ( args ) => args.at( -1 ) ),
		[ 'wordpress:latest', 'wordpress:php7.1' ]
	);
	for ( const args of runs ) {
		assert.equal(
			args.some( ( arg ) =>
				arg.startsWith( 'dev.wp-env-container.xdebug' )
			),
			false
		);
	}
	assert.deepEqual( labelled.runtime.imageRequests, [
		{ update: false, xdebug: false },
	] );
} );

test( 'run with Xdebug mode off loads Xdebug with every mode off', async () => {
	const cli = fakeCLI( { containers: RUNNING } );
	cli.hostGateway = async () => '192.168.64.1';

	await withTTY( false, () =>
		makeRuntime( cli ).run( lockedConfig(), {
			container: 'cli',
			command: [ 'php', '-m' ],
			xdebug: 'off',
		} )
	);

	const [ args ] = cli.calls;
	assert.ok( args.includes( 'XDEBUG_MODE=off' ) );
	assert.ok(
		args.includes( 'PHP_INI_SCAN_DIR=:/usr/local/etc/php/conf.d-xdebug' )
	);
} );

test( 'destroy removes the images before the state directory', async () => {
	const stateDirectoryPath = projectState();
	const cli = fakeCLI();
	cli.listByLabels = async () => [];
	const runtime = makeRuntime( cli );
	const order = [];
	runtime.removeProjectImages = async () => {
		order.push( [ 'images', fs.existsSync( stateDirectoryPath ) ] );
	};

	await runtime.destroy( makeConfig( { stateDirectoryPath } ) );

	assert.deepEqual( order, [ [ 'images', true ] ] );
	assert.equal( fs.existsSync( stateDirectoryPath ), false );
} );

test( 'destroy removes the local images of every recipe for the project PHP versions only', async () => {
	const stateDirectoryPath = projectState();
	const cli = fakeCLI();
	cli.listByLabels = async () => [];
	cli.imageExists = async () => false;
	cli.listImages = async () => [
		'wp-env-container/cli:php8.3-0123abcd',
		'wp-env-container/wordpress:php8.3-0123abcd',
		'wp-env-container/cli:php7.4-0123abcd',
		'wp-env-container/cli:php8.2-0123abcd',
		'wp-env-container/wordpress:php8.2-0123abcd',
		'wp-env-container/cli:php8.3-4567cdef',
	];
	cli.list = async () => [
		{
			name: 'other-cli',
			state: 'stopped',
			image: 'wp-env-container/cli:php8.3-4567cdef',
		},
	];
	const config = makeConfig( {
		stateDirectoryPath,
		testsEnvironment: false,
	} );
	config.env.development.phpVersion = '8.3';
	config.env.tests.phpVersion = '7.4';

	await makeRuntime( cli ).destroy( config );

	const deleted = cli.calls
		.filter( ( args ) => args[ 0 ] === 'image' && args[ 1 ] === 'delete' )
		.map( ( args ) => args[ 2 ] );
	assert.ok( deleted.includes( 'wp-env-container/cli:php8.3-0123abcd' ) );
	assert.ok(
		deleted.includes( 'wp-env-container/wordpress:php8.3-0123abcd' )
	);
	assert.ok( deleted.includes( 'wp-env-container/cli:php7.4-0123abcd' ) );
	assert.equal(
		deleted.some( ( reference ) => reference.includes( 'php8.2' ) ),
		false
	);
	assert.equal(
		deleted.includes( 'wp-env-container/cli:php8.3-4567cdef' ),
		false
	);
	assert.equal( new Set( deleted ).size, deleted.length );
} );

/**
 * @param {string}                name    Container name.
 * @param {'development'|'tests'} env     Environment of the command.
 * @param {string}                [state] Container state.
 * @return {Object} A one-shot CLI container record.
 */
/**
 * @param {string} name    Container name.
 * @param {string} env     Environment label.
 * @param {string} [state] Container state; a `stopped` command has exited unless `extra` says otherwise.
 * @param {Object} [extra] Fields merged over the record.
 * @return {Object} A one-shot CLI container record.
 */
const commandRecord = ( name, env, state = 'running', extra = {} ) => ( {
	name,
	state,
	labels: {
		'dev.wp-env-container.project': 'example-project',
		'dev.wp-env-container.role': 'cli',
		'dev.wp-env-container.env': env,
	},
	ports: [],
	creationDate: '2030-01-01T10:00:00Z',
	startedDate: '2030-01-01T10:00:01Z',
	...extra,
} );

const ALL_RUNNING = [
	'example-project-mysql',
	'example-project-tests-mysql',
	'example-project-wordpress',
	'example-project-tests-wordpress',
];

const TESTS_COMMAND_RUNNING =
	'A command is still running in tests-cli (example-project-phpunit-a1b2c3). Wait for it to finish or stop it with `container stop example-project-phpunit-a1b2c3`.';

/**
 * A fake CLI whose `container run` stays open until `finish` is called.
 *
 * @param {Object} containers Inspect results keyed by container name.
 * @return {{cli: Object, finish: () => void, started: Promise<string[]>}} The CLI, a function that ends the command, and the arguments of the started command.
 */
function pendingCLI( containers ) {
	let finish;
	let markStarted;
	const started = new Promise( ( resolve ) => ( markStarted = resolve ) );
	const cli = fakeCLI( {
		containers,
		onExec: ( args ) => {
			const isCommand = args[ 0 ] === 'run' || args[ 0 ] === 'exec';
			if ( ! isCommand ) {
				return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
			}
			markStarted( args );
			return new Promise( ( resolve ) => {
				finish = () =>
					resolve( {
						exitCode: 0,
						stdout: 'done',
						stderr: '',
						timedOut: false,
					} );
			} );
		},
	} );
	return { cli, finish: () => finish(), started };
}

const lockExists = ( config ) =>
	fs.existsSync( path.join( config.stateDirectoryPath, '.lock' ) );

test( 'wpCli releases the project lock once its container runs and returns the result later', async () => {
	const config = lockedConfig();
	const { cli, finish, started } = pendingCLI( RUNNING );
	const inspect = cli.inspect;
	let lockedAtSetup = null;
	cli.inspect = async ( name ) => {
		if ( name === 'example-project-tests-mysql' ) {
			lockedAtSetup = lockExists( config );
		}
		if ( name.startsWith( 'example-project-wpcli-' ) ) {
			return { state: 'running' };
		}
		return inspect( name );
	};

	const pending = makeRuntime( cli ).wpCli( config, 'tests', [ 'cron' ] );
	const args = await started;
	while ( lockExists( config ) ) {
		await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
	}
	finish();
	const result = await pending;

	assert.equal( lockedAtSetup, true );
	assert.match( args[ args.indexOf( '--name' ) + 1 ], /-wpcli-/ );
	assert.equal( result.stdout, 'done' );
} );

test( 'a one-shot command holds the lock until its container runs', async () => {
	const config = lockedConfig();
	const { cli, finish, started } = pendingCLI( RUNNING );
	const inspect = cli.inspect;
	const states = [ 'stopped', 'stopped', 'running' ];
	const lockWhileStopped = [];
	cli.inspect = async ( name ) => {
		if ( name.startsWith( 'example-project-phpunit-' ) ) {
			const state = states.shift() || 'running';
			if ( state === 'stopped' ) {
				lockWhileStopped.push( lockExists( config ) );
			}
			return { state };
		}
		return inspect( name );
	};

	const pending = makeRuntime( cli ).phpunit( config );
	await started;
	while ( lockExists( config ) ) {
		await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
	}

	assert.equal( states.length, 0 );
	assert.deepEqual( lockWhileStopped, [ true, true ] );
	finish();
	await pending;
} );

test( 'a one-shot command that ends before it is seen running releases the lock', async () => {
	const config = lockedConfig();
	const cli = fakeCLI( { containers: RUNNING } );

	const result = await makeRuntime( cli ).wpCli( config, 'tests', [
		'option',
		'list',
	] );

	assert.equal( result.exitCode, 0 );
	assert.equal( lockExists( config ), false );
} );

test( 'run waits for another lock holder before it reads the database', async () => {
	const { withLock } = require( '../../lib/lock' );
	const config = lockedConfig();
	const cli = fakeCLI( { containers: RUNNING } );
	const runtime = makeRuntime( cli );
	let release;
	const holding = withLock(
		config.stateDirectoryPath,
		() => new Promise( ( resolve ) => ( release = resolve ) )
	);
	while ( ! release ) {
		await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
	}

	const pending = withTTY( false, () =>
		runtime.run( config, { container: 'tests-cli', command: [ 'ls' ] } )
	);
	await new Promise( ( resolve ) => setTimeout( resolve, 600 ) );
	const callsWhileLocked = cli.calls.length;
	release();
	await holding;
	const exitCode = await pending;

	assert.equal( callsWhileLocked, 0 );
	assert.equal( exitCode, 0 );
	assert.match(
		cli.calls[ 0 ][ cli.calls[ 0 ].indexOf( '--name' ) + 1 ],
		/^example-project-run-/
	);
} );

test( 'run releases the lock while a command runs in a long-running container', async () => {
	const config = lockedConfig();
	const { cli, finish, started } = pendingCLI( {
		...RUNNING,
		'example-project-wordpress': { state: 'running' },
	} );

	const pending = withTTY( false, () =>
		makeRuntime( cli ).run( config, {
			container: 'wordpress',
			command: [ 'sh' ],
		} )
	);
	await started;
	while ( lockExists( config ) ) {
		await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
	}
	finish();

	assert.equal( await pending, 0 );
} );

test( 'start refuses to recreate an environment while a command runs in it', async () => {
	const config = lockedConfig();
	const { cli, runtime } = startRuntime( {
		config,
		containers: [
			...ALL_RUNNING.map( ( name ) => runningRecord( name ) ),
			commandRecord( 'example-project-phpunit-a1b2c3', 'tests' ),
		],
	} );
	fs.rmSync( path.join( config.stateDirectoryPath, 'config-hash' ) );

	await assert.rejects( runtime.start( config ), {
		name: 'CommandRunningError',
		message: TESTS_COMMAND_RUNNING,
	} );
	assert.deepEqual( cli.calls, [] );
	assert.deepEqual( runtime.imageRequests, [] );
} );

test( 'start names every running command in its error', async () => {
	const config = lockedConfig();
	const { runtime } = startRuntime( {
		config,
		containers: [
			...ALL_RUNNING.map( ( name ) => runningRecord( name ) ),
			commandRecord( 'example-project-run-d4e5f6', 'development' ),
			commandRecord( 'example-project-phpunit-a1b2c3', 'tests' ),
		],
	} );
	fs.rmSync( path.join( config.stateDirectoryPath, 'config-hash' ) );

	await assert.rejects( runtime.start( config ), {
		message:
			'Commands are still running in cli (example-project-run-d4e5f6) and tests-cli (example-project-phpunit-a1b2c3). Wait for them to finish or stop them with `container stop example-project-run-d4e5f6 example-project-phpunit-a1b2c3`.',
	} );
} );

test( 'start with nothing to recreate succeeds while a command runs', async () => {
	const config = lockedConfig();
	const { runtime, logs } = startRuntime( {
		config,
		containers: [
			...ALL_RUNNING.map( ( name ) => runningRecord( name ) ),
			commandRecord( 'example-project-phpunit-a1b2c3', 'tests' ),
		],
	} );

	await runtime.start( config );

	assert.ok( logs.includes( 'Environment already running.' ) );
} );

test( 'start recreates the web containers while a command runs on a database it keeps', async () => {
	const config = lockedConfig();
	const { cli, runtime } = startRuntime( {
		config,
		containers: [
			...ALL_RUNNING.map( ( name ) => runningRecord( name ) ),
			commandRecord( 'example-project-phpunit-a1b2c3', 'tests' ),
		],
	} );

	await runtime.start( config, { xdebug: true } );

	const runs = cli.calls.filter( ( args ) => args[ 0 ] === 'run' );
	assert.equal( runs.length, 2 );
} );

test( 'start refuses only the environment whose database is recreated', async () => {
	// The development database is stopped, so `start` starts it again.
	const containers = [
		runningRecord( 'example-project-tests-mysql' ),
		runningRecord( 'example-project-wordpress' ),
		runningRecord( 'example-project-tests-wordpress' ),
	];
	const testsConfig = lockedConfig();
	const testsCommand = startRuntime( {
		config: testsConfig,
		containers: [
			...containers,
			commandRecord( 'example-project-phpunit-a1b2c3', 'tests' ),
		],
	} );
	const developmentConfig = lockedConfig();
	const developmentCommand = startRuntime( {
		config: developmentConfig,
		containers: [
			...containers,
			commandRecord( 'example-project-run-d4e5f6', 'development' ),
		],
	} );

	await testsCommand.runtime.start( testsConfig );
	await assert.rejects(
		developmentCommand.runtime.start( developmentConfig ),
		{
			message:
				'A command is still running in cli (example-project-run-d4e5f6). Wait for it to finish or stop it with `container stop example-project-run-d4e5f6`.',
		}
	);

	assert.equal(
		testsCommand.cli.calls.filter( ( args ) => args[ 0 ] === 'run' ).length,
		2
	);
	assert.deepEqual( developmentCommand.cli.calls, [] );
} );

test( 'start ignores a command container that has exited', async () => {
	const config = lockedConfig();
	const { cli, runtime } = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-mysql' ),
			runningRecord( 'example-project-wordpress' ),
			runningRecord( 'example-project-tests-wordpress' ),
			commandRecord(
				'example-project-phpunit-a1b2c3',
				'tests',
				'stopped'
			),
		],
	} );

	await runtime.start( config );

	assert.equal(
		cli.calls.filter( ( args ) => args[ 0 ] === 'run' ).length,
		2
	);
} );

test( 'start refuses to recreate an environment while a command container is still booting', async () => {
	const booting = commandRecord(
		'example-project-phpunit-a1b2c3',
		'tests',
		'stopped',
		{
			creationDate: new Date( Date.now() - 90 * 1000 ).toISOString(),
			startedDate: undefined,
		}
	);
	for ( const record of [
		booting,
		commandRecord( 'example-project-phpunit-a1b2c3', 'tests', 'stopping' ),
	] ) {
		const config = lockedConfig();
		const { runtime } = startRuntime( {
			config,
			containers: [
				...ALL_RUNNING.map( ( name ) => runningRecord( name ) ),
				record,
			],
		} );
		fs.rmSync( path.join( config.stateDirectoryPath, 'config-hash' ) );

		await assert.rejects(
			runtime.start( config ),
			{ name: 'CommandRunningError', message: TESTS_COMMAND_RUNNING },
			record.state
		);
	}
} );

test( 'start ignores a command container that never started and was abandoned', async () => {
	const config = lockedConfig();
	const { cli, runtime } = startRuntime( {
		config,
		containers: [
			...ALL_RUNNING.map( ( name ) => runningRecord( name ) ),
			commandRecord(
				'example-project-phpunit-a1b2c3',
				'tests',
				'stopped',
				{
					creationDate: new Date(
						Date.now() - 60 * 60 * 1000
					).toISOString(),
					startedDate: undefined,
				}
			),
		],
	} );
	fs.rmSync( path.join( config.stateDirectoryPath, 'config-hash' ) );
	runtime.configureWordPress = async () => {};
	const downloadSources = sources.downloadSources;
	sources.downloadSources = async () => {};
	runtime.prepareCore = async () => {};
	try {
		await runtime.start( config );
	} finally {
		sources.downloadSources = downloadSources;
	}

	assert.equal( runCalls( cli ).length, 2 );
} );

test( 'start keeps the disabled tests containers while a command runs in tests-cli', async () => {
	const config = lockedConfig( { testsEnvironment: false } );
	const { cli, runtime } = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-mysql' ),
			runningRecord( 'example-project-tests-mysql' ),
			runningRecord( 'example-project-wordpress' ),
			commandRecord( 'example-project-phpunit-a1b2c3', 'tests' ),
		],
	} );

	await assert.rejects( runtime.start( config ), {
		message: TESTS_COMMAND_RUNNING,
	} );
	assert.deepEqual( cli.calls, [] );
} );

test( 'reset refuses an environment while a command runs in it and resets the others', async () => {
	const config = lockedConfig();
	const cli = fakeCLI( { containers: RUNNING } );
	cli.listByLabels = async () => [
		commandRecord( 'example-project-phpunit-a1b2c3', 'tests' ),
		commandRecord( 'example-project-wpcli-0f0f0f', 'tests', 'stopped' ),
	];
	const runtime = makeRuntime( cli );
	const configured = [];
	runtime.configureWordPress = async ( _config, env ) =>
		configured.push( env );

	await assert.rejects( runtime.clean( config, { environment: 'tests' } ), {
		message: TESTS_COMMAND_RUNNING,
	} );
	await assert.rejects( runtime.clean( config, { environment: 'all' } ), {
		message: TESTS_COMMAND_RUNNING,
	} );
	assert.deepEqual( cli.calls, [] );

	await runtime.clean( config, { environment: 'development' } );

	assert.deepEqual( configured, [ 'development' ] );
} );

test( 'stop, cleanup and destroy stop running commands first and log each one', async () => {
	for ( const method of [ 'stop', 'cleanup', 'destroy' ] ) {
		const config = lockedConfig();
		const logs = [];
		const cli = fakeCLI();
		cli.listByLabels = async () => [
			runningRecord( 'example-project-mysql' ),
			commandRecord( 'example-project-phpunit-a1b2c3', 'tests' ),
			commandRecord( 'example-project-run-d4e5f6', 'development' ),
			commandRecord( 'example-project-wpcli-0f0f0f', 'tests', 'stopped' ),
		];
		const runtime = new AppleContainerRuntime( {
			cli,
			log: ( message ) => logs.push( message ),
		} );

		await runtime[ method ]( config );

		const stops = cli.calls.filter( ( args ) => args[ 0 ] === 'stop' );
		assert.deepEqual( stops, [
			[
				'stop',
				'example-project-phpunit-a1b2c3',
				'example-project-run-d4e5f6',
			],
			[ 'stop', 'example-project-mysql' ],
		] );
		assert.deepEqual( logs.slice( 0, 3 ), [
			'Stopping example-project-phpunit-a1b2c3, a command still running in tests-cli.',
			'Stopping example-project-run-d4e5f6, a command still running in cli.',
			'Stopping example-project-mysql.',
		] );
	}
} );

/**
 * @param {Object} cli Fake CLI that recorded one `configureWordPress` run.
 * @return {string} The script of the recorded run.
 */
const configureScript = ( cli ) => {
	const call = cli.calls.find( ( args ) => args.includes( 'bash' ) );
	return call[ call.indexOf( '-c' ) + 1 ];
};

const DELETE_MULTISITE_CONSTANTS = [
	'WP_ALLOW_MULTISITE',
	'MULTISITE',
	'SUBDOMAIN_INSTALL',
	'DOMAIN_CURRENT_SITE',
	'PATH_CURRENT_SITE',
	'SITE_ID_CURRENT_SITE',
	'BLOG_ID_CURRENT_SITE',
]
	.map( ( name ) => `{ wp config delete '${ name }' 2> /dev/null || true; }` )
	.join( ' && ' );

test( 'configureWordPress removes stale multisite constants before a fresh multisite install', async () => {
	const cli = fakeCLI();
	const config = recipes.withWordPressPort(
		makeConfig(),
		'development',
		8951
	);
	config.env.development.multisite = true;
	config.env.development.config.SUBDOMAIN_INSTALL = false;

	await makeRuntime( cli ).configureWordPress(
		config,
		'development',
		'192.168.64.9',
		{ previousUrl: 'http://localhost:8950', freshInstall: true }
	);

	const script = configureScript( cli );
	const deletes = script.indexOf( DELETE_MULTISITE_CONSTANTS );
	const install = script.indexOf( 'wp core multisite-install' );
	const reapply = script.indexOf(
		"wp config set 'SUBDOMAIN_INSTALL' 'false'"
	);
	assert.ok( deletes > 0 );
	assert.ok( deletes < install );
	assert.ok( install < reapply );
	assert.match( script, /--url='http:\/\/localhost:8951'/ );
	assert.doesNotMatch( script, /search-replace/ );
} );

test( 'configureWordPress removes multisite constants before a fresh single-site install', async () => {
	const cli = fakeCLI();

	await makeRuntime( cli ).configureWordPress(
		makeConfig(),
		'development',
		'192.168.64.9',
		{ freshInstall: true }
	);

	const script = configureScript( cli );
	const deletes = script.indexOf( DELETE_MULTISITE_CONSTANTS );
	assert.ok( deletes > 0 );
	assert.ok( deletes < script.indexOf( 'wp core install' ) );
} );

test( 'configureWordPress removes the $base line of an earlier network before a fresh install only', async () => {
	const fresh = fakeCLI();
	const existing = fakeCLI();
	const config = makeConfig();
	config.env.development.multisite = true;

	await makeRuntime( fresh ).configureWordPress(
		config,
		'development',
		'192.168.64.9',
		{ freshInstall: true }
	);
	await makeRuntime( existing ).configureWordPress(
		config,
		'development',
		'192.168.64.9'
	);

	const script = configureScript( fresh );
	const deleteBase =
		'{ wp config delete base --type=variable 2> /dev/null || true; }';
	assert.ok( script.includes( deleteBase ) );
	assert.ok(
		script.indexOf( deleteBase ) <
			script.indexOf( 'wp core multisite-install' )
	);
	assert.equal( configureScript( existing ).includes( deleteBase ), false );
} );

test( 'configureWordPress keeps the multisite constants of an existing install', async () => {
	const cli = fakeCLI();
	const config = makeConfig();
	config.env.development.multisite = true;

	await makeRuntime( cli ).configureWordPress(
		config,
		'development',
		'192.168.64.9'
	);

	assert.doesNotMatch(
		configureScript( cli ),
		/wp config delete 'MULTISITE'/
	);
} );

test( 'start and reset install WordPress fresh on an empty database', async () => {
	const config = lockedConfig();
	const { runtime } = startRuntime( {
		config,
		containers: [
			runningRecord( 'example-project-tests-mysql' ),
			runningRecord( 'example-project-wordpress' ),
			runningRecord( 'example-project-tests-wordpress' ),
		],
	} );
	fs.rmSync( path.join( config.stateDirectoryPath, 'mysql' ), {
		recursive: true,
	} );
	const configured = [];
	const record = async ( _config, env, _dbHost, options ) =>
		configured.push( [ env, options ] );
	runtime.configureWordPress = record;
	const resetRuntime = makeRuntime( fakeCLI( { containers: RUNNING } ) );
	resetRuntime.configureWordPress = record;

	await runtime.start( config );
	await resetRuntime.clean( config, { environment: 'tests' } );

	assert.deepEqual( configured, [
		[ 'development', { previousUrl: undefined, freshInstall: true } ],
		[ 'tests', { freshInstall: true } ],
	] );
} );

test( 'wpCli rejects promptly and releases the lock when its setup fails', async () => {
	const config = lockedConfig();
	const containers = {};
	const cli = fakeCLI( { containers } );
	const runtime = makeRuntime( cli );
	const startedAt = Date.now();

	await assert.rejects( runtime.wpCli( config, 'tests', [ 'cron' ] ), {
		message:
			'The tests database is not running. Start the environment with `wp-env-container start`.',
	} );

	assert.ok( Date.now() - startedAt < 1000 );
	assert.equal( lockExists( config ), false );
	Object.assign( containers, RUNNING );
	const result = await runtime.wpCli( config, 'tests', [ 'cron' ] );
	assert.equal( result.exitCode, 0 );
} );

test( 'a failing inspect while a one-shot container starts leaves the command running', async () => {
	const config = lockedConfig();
	const { cli, finish, started } = pendingCLI( RUNNING );
	const inspect = cli.inspect;
	cli.inspect = async ( name ) => {
		if ( name.startsWith( 'example-project-wpcli-' ) ) {
			throw new Error( 'inspect failed' );
		}
		return inspect( name );
	};
	const runtime = makeRuntime( cli );
	runtime.launchTimeoutMs = 300;

	const pending = runtime.wpCli( config, 'tests', [ 'cron' ] );
	await started;
	while ( lockExists( config ) ) {
		await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
	}
	finish();

	assert.equal( ( await pending ).stdout, 'done' );
} );

test(
	'a hung inspect holds the lock no longer than the launch timeout',
	{ timeout: 5000 },
	async () => {
		const config = lockedConfig();
		const { cli, finish, started } = pendingCLI( RUNNING );
		const inspect = cli.inspect;
		cli.inspect = ( name ) =>
			name.startsWith( 'example-project-phpunit-' )
				? new Promise( () => {} )
				: inspect( name );
		const runtime = makeRuntime( cli );
		runtime.launchTimeoutMs = 300;

		const pending = runtime.phpunit( config );
		await started;
		const startedAt = Date.now();
		while ( lockExists( config ) ) {
			await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
		}
		const heldMs = Date.now() - startedAt;
		finish();
		await pending;

		assert.ok( heldMs < 1000, `lock held ${ heldMs } ms` );
	}
);

test( 'getFeatures reports phpMyAdmin support', () => {
	assert.equal( makeRuntime( fakeCLI() ).getFeatures().phpMyAdmin, true );
} );

test( 'getRunContainers lists phpmyadmin', () => {
	assert.ok(
		makeRuntime( fakeCLI() ).getRunContainers().includes( 'phpmyadmin' )
	);
} );

test( 'run in phpmyadmin execs in the development phpMyAdmin container', async () => {
	const containers = {
		'example-project-phpmyadmin': { state: 'running' },
	};
	const cli = fakeCLI( { containers } );

	await withTTY( false, () =>
		makeRuntime( cli ).run( lockedConfig(), {
			container: 'phpmyadmin',
			command: [ 'sh' ],
		} )
	);
	await assert.rejects(
		makeRuntime( fakeCLI() ).run( lockedConfig(), {
			container: 'phpmyadmin',
			command: [ 'sh' ],
		} ),
		{
			message:
				'phpMyAdmin is not running. Set "phpmyadmin": true in .wp-env.json and start the environment with `wp-env-container start`.',
		}
	);

	assert.deepEqual( cli.calls[ 0 ], [
		'exec',
		'-i',
		'-w',
		'/var/www/html',
		'example-project-phpmyadmin',
		'sh',
	] );
} );

test( 'run in phpmyadmin says to start the environment when phpMyAdmin is on but stopped', async () => {
	const config = lockedConfig();
	config.env.development.phpmyadmin = true;

	await assert.rejects(
		makeRuntime( fakeCLI() ).run( config, {
			container: 'phpmyadmin',
			command: [ 'sh' ],
		} ),
		{
			name: 'EnvironmentNotRunningError',
			message:
				'phpMyAdmin is not running. Start the environment with `wp-env-container start`.',
		}
	);
} );

const DB_IPS = {
	'example-project-mysql': '192.168.64.9',
	'example-project-tests-mysql': '192.168.64.9',
};

/**
 * @param {Object} [overrides] Values merged over the default config.
 * @return {Object} A config whose environments run phpMyAdmin.
 */
function phpmyadminConfig( overrides = {} ) {
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
		...overrides,
	} );
	config.env.development.phpmyadmin = true;
	config.env.tests.phpmyadmin = true;
	return config;
}

/**
 * @param {string} name     Container name.
 * @param {Object} [labels] Labels merged over the project label.
 * @return {Object} A running record whose database address is `DB_IPS`.
 */
function runningWithAddress( name, labels = {} ) {
	return {
		...runningRecord( name, labels ),
		ipAddress: DB_IPS[ name ],
	};
}

const CURRENT_PHPMYADMIN = {
	'dev.wp-env-container.db-host': '192.168.64.9',
};

/**
 * @return {Object[]} Records of a running environment with both phpMyAdmin servers on the saved ports and the current database address.
 */
function phpmyadminProject() {
	return [
		...ALL_RUNNING.map( ( name ) => runningWithAddress( name ) ),
		runningRecord( 'example-project-phpmyadmin', CURRENT_PHPMYADMIN ),
		runningRecord( 'example-project-tests-phpmyadmin', CURRENT_PHPMYADMIN ),
	];
}

const runCalls = ( cli ) => cli.calls.filter( ( args ) => args[ 0 ] === 'run' );

const phpmyadminRuns = ( cli ) =>
	runCalls( cli ).filter( ( args ) => args.at( -1 ) === 'phpmyadmin' );

test( 'start runs a phpMyAdmin container per environment on loopback and returns the URLs, reusing the saved ports', async () => {
	const config = phpmyadminConfig();
	const { cli, runtime, logs } = startRuntime( { config, containers: [] } );

	const urls = await runtime.start( config );

	const runs = phpmyadminRuns( cli );
	assert.equal( runs.length, 2 );
	assert.deepEqual(
		runs.map( ( args ) => args[ args.indexOf( '-p' ) + 1 ] ),
		[ '127.0.0.1:50011:80', '127.0.0.1:50012:80' ]
	);
	assert.ok( runs[ 0 ].includes( 'PMA_HOST=192.168.64.9' ) );
	assert.ok( runs[ 0 ].includes( '--rm' ) );
	assert.ok(
		runs[ 1 ].includes( 'dev.wp-env-container.role=phpmyadmin' ) &&
			runs[ 1 ].includes( 'dev.wp-env-container.env=tests' )
	);
	assert.deepEqual( urls, {
		siteUrl: 'http://localhost:8888',
		testsUrl: 'http://localhost:8889',
		phpmyadminUrl: 'http://localhost:50011',
		testsPhpmyadminUrl: 'http://localhost:50012',
	} );
	assert.ok( logs.includes( 'Starting example-project-phpmyadmin.' ) );
	const state = JSON.parse(
		fs.readFileSync(
			path.join( config.stateDirectoryPath, 'environments.json' ),
			'utf8'
		)
	);
	assert.equal( state.development.phpmyadmin, 50011 );
	assert.equal( state.tests.phpmyadmin, 50012 );
} );

test( 'start runs each phpMyAdmin after the databases and before the WordPress containers', async () => {
	const config = phpmyadminConfig();
	const order = [];
	const { cli, runtime } = startRuntime( { config, containers: [] } );
	runtime.startDatabase = async () => {
		order.push( 'database' );
		return '192.168.64.9';
	};
	const run = cli.run;
	cli.run = async ( args ) => {
		order.push( args.at( -1 ) );
		return run( args );
	};

	await runtime.start( config );

	assert.deepEqual( order, [
		'database',
		'database',
		'phpmyadmin',
		'phpmyadmin',
		'wordpress:latest',
		'wordpress:latest',
	] );
} );

test( 'start gives the tests phpMyAdmin a random port and logs it when phpmyadminPort is set at the root', async () => {
	const config = phpmyadminConfig();
	config.env.development.phpmyadminPort = 8995;
	config.env.tests.phpmyadminPort = 8995;
	const { cli, runtime, logs } = startRuntime( { config, containers: [] } );

	const urls = await runtime.start( config );

	assert.equal( urls.phpmyadminUrl, 'http://localhost:8995' );
	assert.equal( urls.testsPhpmyadminUrl, 'http://localhost:50012' );
	assert.equal( phpmyadminRuns( cli ).length, 2 );
	assert.deepEqual(
		logs.filter( ( message ) => message.startsWith( 'Tests phpMyAdmin' ) ),
		[
			'Tests phpMyAdmin uses port 50012; "phpmyadminPort" 8995 belongs to the development phpMyAdmin.',
		]
	);
} );

test( 'start stops on a busy phpmyadminPort', async () => {
	const config = phpmyadminConfig();
	config.env.development.phpmyadminPort = 8995;
	const { runtime } = startRuntime( { config, containers: [] } );
	runtime.isPortFree = async ( port ) => port !== 8995;

	await assert.rejects(
		runtime.start( config ),
		/^Error: Port 8995 \(phpMyAdmin\) is already in use\. Free it, set another "phpmyadminPort"/
	);
} );

test( 'start leaves a current environment with its phpMyAdmin containers alone', async () => {
	const config = phpmyadminConfig();
	const { cli, runtime, logs } = startRuntime( {
		config,
		containers: phpmyadminProject(),
	} );

	const urls = await runtime.start( config );

	assert.deepEqual( logs, [ 'Environment already running.' ] );
	assert.deepEqual( cli.calls, [] );
	assert.equal( urls.phpmyadminUrl, 'http://localhost:50011' );
	assert.equal( urls.testsPhpmyadminUrl, 'http://localhost:50012' );
} );

test( 'start does not take the already-running shortcut when a wanted phpMyAdmin is missing', async () => {
	const config = phpmyadminConfig();
	const { cli, runtime, logs } = startRuntime( {
		config,
		containers: phpmyadminProject().filter(
			( record ) => record.name !== 'example-project-tests-phpmyadmin'
		),
	} );

	await runtime.start( config );

	assert.equal( logs.includes( 'Environment already running.' ), false );
	const runs = phpmyadminRuns( cli );
	assert.equal( runs.length, 1 );
	assert.ok( runs[ 0 ].includes( 'example-project-tests-phpmyadmin' ) );
	assert.equal(
		cli.calls.some(
			( args ) =>
				args[ 0 ] === 'stop' &&
				args.includes( 'example-project-phpmyadmin' )
		),
		false
	);
} );

test( 'start recreates a phpMyAdmin whose configured port changed', async () => {
	const config = phpmyadminConfig();
	config.env.development.phpmyadminPort = 8995;
	const { cli, runtime, logs } = startRuntime( {
		config,
		containers: phpmyadminProject(),
	} );

	const urls = await runtime.start( config );

	assert.equal( logs.includes( 'Environment already running.' ), false );
	assert.equal( urls.phpmyadminUrl, 'http://localhost:8995' );
	assert.ok(
		cli.calls.some(
			( args ) =>
				args[ 0 ] === 'stop' &&
				args[ 1 ] === 'example-project-phpmyadmin'
		)
	);
	const runs = phpmyadminRuns( cli );
	assert.equal( runs.length, 1 );
	assert.equal(
		runs[ 0 ][ runs[ 0 ].indexOf( '-p' ) + 1 ],
		'127.0.0.1:8995:80'
	);
} );

test( 'start recreates a phpMyAdmin whose database address changed', async () => {
	const config = phpmyadminConfig();
	const containers = phpmyadminProject().map( ( record ) =>
		record.name === 'example-project-tests-phpmyadmin'
			? runningRecord( record.name, {
					'dev.wp-env-container.db-host': '192.168.64.77',
				} )
			: record
	);
	const { cli, runtime, logs } = startRuntime( { config, containers } );

	await runtime.start( config );

	assert.equal( logs.includes( 'Environment already running.' ), false );
	const runs = phpmyadminRuns( cli );
	assert.equal( runs.length, 1 );
	assert.ok( runs[ 0 ].includes( 'PMA_HOST=192.168.64.9' ) );
	assert.ok( runs[ 0 ].includes( 'example-project-tests-phpmyadmin' ) );
} );

test( 'start recreates a phpMyAdmin when its database is recreated at a new address', async () => {
	const config = phpmyadminConfig();
	const containers = phpmyadminProject().map( ( record ) =>
		record.name === 'example-project-mysql'
			? { ...record, state: 'stopped' }
			: record
	);
	const { cli, runtime } = startRuntime( { config, containers } );
	runtime.startDatabase = async () => '192.168.64.50';

	await runtime.start( config );

	const runs = phpmyadminRuns( cli );
	assert.equal( runs.length, 2 );
	assert.ok( runs[ 0 ].includes( 'PMA_HOST=192.168.64.50' ) );
	assert.ok( runs[ 0 ].includes( 'example-project-phpmyadmin' ) );
} );

test( 'start removes a running phpMyAdmin once phpmyadmin is off', async () => {
	const config = phpmyadminConfig();
	config.env.development.phpmyadmin = false;
	delete config.env.development.phpmyadminPort;
	const { cli, runtime, logs } = startRuntime( {
		config,
		containers: phpmyadminProject(),
	} );

	const urls = await runtime.start( config );

	assert.deepEqual( cli.calls.slice( 0, 2 ), [
		[ 'stop', 'example-project-phpmyadmin' ],
		[ 'delete', '--force', 'example-project-phpmyadmin' ],
	] );
	assert.ok(
		logs.includes(
			'Removing example-project-phpmyadmin ("phpmyadmin": false).'
		)
	);
	assert.equal( logs.includes( 'Environment already running.' ), true );
	assert.equal( urls.phpmyadminUrl, null );
	assert.equal( urls.testsPhpmyadminUrl, 'http://localhost:50012' );
	const state = JSON.parse(
		fs.readFileSync(
			path.join( config.stateDirectoryPath, 'environments.json' ),
			'utf8'
		)
	);
	assert.equal( 'phpmyadmin' in state.development, false );
} );

test( 'start removes the tests phpMyAdmin when testsEnvironment is false, even while tests-cli runs a command', async () => {
	const config = phpmyadminConfig( { testsEnvironment: false } );
	const { cli, runtime } = startRuntime( {
		config,
		containers: [
			runningWithAddress( 'example-project-mysql' ),
			runningRecord( 'example-project-wordpress' ),
			runningRecord( 'example-project-phpmyadmin', CURRENT_PHPMYADMIN ),
			runningRecord(
				'example-project-tests-phpmyadmin',
				CURRENT_PHPMYADMIN
			),
			commandRecord( 'example-project-phpunit-a1b2c3', 'tests' ),
		],
	} );

	await runtime.start( config );

	assert.deepEqual( cli.calls, [
		[ 'stop', 'example-project-tests-phpmyadmin' ],
		[ 'delete', '--force', 'example-project-tests-phpmyadmin' ],
	] );
} );

/**
 * @param {Object} config Project configuration.
 * @param {Object} fields Fields merged over the development environment.
 * @return {Object} A copy of `config` with the development fields replaced.
 */
function withDevelopment( config, fields ) {
	return {
		...config,
		env: {
			...config.env,
			development: { ...config.env.development, ...fields },
		},
	};
}

/**
 * @param {Object} cli Fake container CLI.
 * @return {boolean} Whether a WordPress container was stopped or run.
 */
const touchedWordPress = ( cli ) =>
	cli.calls.some(
		( args ) =>
			( args[ 0 ] === 'stop' || args[ 0 ] === 'run' ) &&
			args.some( ( arg ) => /-wordpress$/.test( arg ) )
	);

test( 'start moves phpMyAdmin to a new port while a command runs in cli, keeping the databases and WordPress', async () => {
	const savedConfig = phpmyadminConfig();
	const config = withDevelopment( savedConfig, { phpmyadminPort: 8995 } );
	const { cli, runtime, logs } = startRuntime( {
		config,
		savedConfig,
		containers: [
			...phpmyadminProject(),
			commandRecord( 'example-project-wpcli-a1b2c3', 'development' ),
		],
	} );

	const urls = await runtime.start( config );

	assert.equal( phpmyadminRuns( cli ).length, 1 );
	assert.equal( urls.phpmyadminUrl, 'http://localhost:8995' );
	assert.deepEqual( runtime.databaseStarts, [] );
	assert.equal( touchedWordPress( cli ), false );
	assert.equal( logs.includes( 'Downloading sources.' ), false );
} );

test( 'start turns phpMyAdmin on while a command runs in cli without recreating the databases or configuring WordPress', async () => {
	const savedConfig = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-test-' ),
	} );
	const config = phpmyadminConfig( {
		stateDirectoryPath: savedConfig.stateDirectoryPath,
	} );
	const { cli, runtime, logs } = startRuntime( {
		config,
		savedConfig,
		containers: [
			...ALL_RUNNING.map( ( name ) => runningWithAddress( name ) ),
			commandRecord( 'example-project-run-d4e5f6', 'development' ),
		],
	} );
	let nextPort = 50020;
	runtime.pickRandomPort = async () => nextPort++;

	const urls = await runtime.start( config );

	assert.equal( phpmyadminRuns( cli ).length, 2 );
	assert.ok( urls.phpmyadminUrl );
	assert.ok( urls.testsPhpmyadminUrl );
	assert.deepEqual( runtime.databaseStarts, [] );
	assert.equal( touchedWordPress( cli ), false );
	assert.equal( logs.includes( 'Downloading sources.' ), false );
	assert.equal( logs.includes( 'Configuring WordPress.' ), false );
	const state = JSON.parse(
		fs.readFileSync(
			path.join( config.stateDirectoryPath, 'environments.json' ),
			'utf8'
		)
	);
	assert.equal(
		state.development.phpmyadmin,
		Number( new URL( urls.phpmyadminUrl ).port )
	);
} );

test( 'start restarts only a stopped phpMyAdmin when the rest is current', async () => {
	const config = phpmyadminConfig();
	const containers = phpmyadminProject().map( ( record ) =>
		record.name === 'example-project-phpmyadmin'
			? { ...record, state: 'stopped' }
			: record
	);
	const { cli, runtime, logs } = startRuntime( { config, containers } );

	const urls = await runtime.start( config );

	const runs = phpmyadminRuns( cli );
	assert.equal( runs.length, 1 );
	assert.ok( runs[ 0 ].includes( 'example-project-phpmyadmin' ) );
	assert.ok( runs[ 0 ].includes( 'PMA_HOST=192.168.64.9' ) );
	assert.equal( touchedWordPress( cli ), false );
	assert.deepEqual( runtime.databaseStarts, [] );
	assert.equal( logs.includes( 'Environment already running.' ), false );
	assert.equal( urls.phpmyadminUrl, 'http://localhost:50011' );
	assert.equal( urls.testsPhpmyadminUrl, 'http://localhost:50012' );
} );

test( 'start recreates a current phpMyAdmin with update and one that runs another image', async () => {
	const config = phpmyadminConfig();
	const { cli, runtime } = startRuntime( {
		config,
		containers: phpmyadminProject(),
	} );
	runtime.configureWordPress = async () => {};
	runtime.prepareCore = async () => {};
	const downloadSources = sources.downloadSources;
	sources.downloadSources = async () => {};
	try {
		await runtime.start( config, { update: true } );
	} finally {
		sources.downloadSources = downloadSources;
	}
	assert.equal( phpmyadminRuns( cli ).length, 2 );

	const otherConfig = phpmyadminConfig();
	const other = startRuntime( {
		config: otherConfig,
		containers: phpmyadminProject().map( ( record ) =>
			record.name === 'example-project-tests-phpmyadmin'
				? { ...record, image: 'docker.io/example/admin:1' }
				: {
						...record,
						image: 'docker.io/library/phpmyadmin:latest',
					}
		),
	} );
	await other.runtime.start( otherConfig );
	const runs = phpmyadminRuns( other.cli );
	assert.equal( runs.length, 1 );
	assert.ok( runs[ 0 ].includes( 'example-project-tests-phpmyadmin' ) );
} );

const OLD_DIGEST = 'sha256:' + 'a'.repeat( 64 );
const NEW_DIGEST = 'sha256:' + 'b'.repeat( 64 );

/**
 * @param {?string} running Digest the phpMyAdmin containers run, if known.
 * @param {?string} local   Digest the local phpMyAdmin tag points to, if known.
 * @return {Promise<Object>} The CLI of a start against a current environment.
 */
async function startWithDigests( running, local ) {
	const config = phpmyadminConfig();
	const { cli, runtime, logs } = startRuntime( {
		config,
		containers: phpmyadminProject().map( ( record ) =>
			record.name.endsWith( 'phpmyadmin' )
				? { ...record, ...( running && { imageDigest: running } ) }
				: record
		),
	} );
	cli.imageDigest = async () => local;
	await runtime.start( config );
	return { cli, logs };
}

test( 'start keeps phpMyAdmin whose digest equals the local tag digest', async () => {
	const { cli, logs } = await startWithDigests( OLD_DIGEST, OLD_DIGEST );
	assert.deepEqual( logs, [ 'Environment already running.' ] );
	assert.deepEqual( phpmyadminRuns( cli ), [] );
} );

test( 'start recreates phpMyAdmin whose digest differs from the local tag digest', async () => {
	const { cli } = await startWithDigests( OLD_DIGEST, NEW_DIGEST );
	assert.equal( phpmyadminRuns( cli ).length, 2 );
} );

test( 'start keeps phpMyAdmin when the running or the local digest is unknown', async () => {
	const unknownRunning = await startWithDigests( null, NEW_DIGEST );
	assert.deepEqual( phpmyadminRuns( unknownRunning.cli ), [] );
	const unknownLocal = await startWithDigests( OLD_DIGEST, null );
	assert.deepEqual( phpmyadminRuns( unknownLocal.cli ), [] );
} );

test( 'configHash leaves out ports, the phpMyAdmin settings and the WordPress port inside the URLs', () => {
	const config = makeConfig();
	const moved = withDevelopment(
		recipes.withWordPressPort( config, 'development', 8890 ),
		{ mysqlPort: 13306, phpmyadmin: true, phpmyadminPort: 8995 }
	);
	const customHost = withDevelopment( config, {
		config: {
			...config.env.development.config,
			WP_SITEURL: 'http://example.test:8888',
		},
	} );
	const otherPhp = withDevelopment( config, { phpVersion: '8.2' } );
	const customHome = withDevelopment( config, {
		config: {
			...config.env.development.config,
			WP_HOME: 'http://localhost:9999',
		},
	} );

	assert.equal( configHash( moved ), configHash( config ) );
	assert.notEqual( configHash( customHost ), configHash( config ) );
	assert.notEqual( configHash( customHome ), configHash( config ) );
	assert.notEqual( configHash( otherPhp ), configHash( config ) );
} );

test( 'start moves WordPress to a new configured port and reconfigures that site only, keeping the databases', async () => {
	const savedConfig = lockedConfig();
	const config = recipes.withWordPressPort(
		savedConfig,
		'development',
		8890
	);
	const { cli, runtime, logs } = startRuntime( {
		config,
		savedConfig,
		containers: ALL_RUNNING.map( ( name ) => runningRecord( name ) ),
	} );
	const configured = [];
	runtime.configureWordPress = async ( started, env ) =>
		configured.push( [ env, started.env[ env ].config.WP_SITEURL ] );

	const urls = await runtime.start( config );

	assert.equal( urls.siteUrl, 'http://localhost:8890' );
	assert.deepEqual( configured, [
		[ 'development', 'http://localhost:8890' ],
	] );
	assert.ok(
		runtime.databaseStarts.every( ( options ) => ! options.recreate )
	);
	assert.equal( logs.includes( 'Downloading sources.' ), false );
	const run = runCalls( cli ).find( ( args ) =>
		args.includes( 'example-project-wordpress' )
	);
	assert.equal( run[ run.indexOf( '-p' ) + 1 ], '0.0.0.0:8890:80' );
} );

test( 'stop stops a running phpMyAdmin with the other containers', async () => {
	const config = lockedConfig();
	const cli = fakeCLI();
	cli.listByLabels = async () => [
		runningRecord( 'example-project-phpmyadmin' ),
	];

	await makeRuntime( cli ).stop( config );

	assert.deepEqual( cli.calls[ 0 ], [
		'stop',
		'example-project-phpmyadmin',
	] );
	assert.deepEqual( cli.calls[ 1 ], [
		'delete',
		'--force',
		'example-project-phpmyadmin',
	] );
} );

test( 'prepareImages pulls the phpmyadmin image only where phpMyAdmin is on', async () => {
	const pulls = [];
	const cli = fakeCLI();
	cli.imageExists = async () => false;
	cli.run = async ( args ) => {
		if ( args[ 1 ] === 'pull' ) {
			pulls.push( args[ 2 ] );
		}
		return '';
	};
	const runtime = makeRuntime( cli );
	runtime.buildImages = async () => {};
	runtime.isBuilderRunning = async () => true;

	await runtime.prepareImages( makeConfig(), [ 'development', 'tests' ], {
		update: false,
	} );
	assert.equal( pulls.includes( 'phpmyadmin' ), false );

	const config = makeConfig();
	config.env.tests.phpmyadmin = true;
	await runtime.prepareImages( config, [ 'development', 'tests' ], {
		update: false,
	} );
	assert.equal( pulls.filter( ( name ) => name === 'phpmyadmin' ).length, 1 );
} );

test( 'prepareImages pulls phpmyadmin again with update', async () => {
	const pulls = [];
	const cli = fakeCLI();
	cli.imageExists = async () => true;
	cli.run = async ( args ) => {
		if ( args[ 1 ] === 'pull' ) {
			pulls.push( args[ 2 ] );
		}
		return '';
	};
	const runtime = makeRuntime( cli );
	runtime.buildImages = async () => {};
	runtime.isBuilderRunning = async () => true;
	const config = phpmyadminConfig();

	await runtime.prepareImages( config, [ 'development' ], { update: false } );
	assert.deepEqual( pulls, [] );
	await runtime.prepareImages( config, [ 'development' ], { update: true } );

	assert.ok( pulls.includes( 'phpmyadmin' ) );
} );

test( 'destroy deletes the phpmyadmin image unless another container uses it', async () => {
	const deletedImages = async ( inUse ) => {
		const cli = fakeCLI();
		cli.listByLabels = async () => [];
		cli.imageExists = async () => false;
		cli.list = async () => inUse;
		const config = phpmyadminConfig();
		config.stateDirectoryPath = projectState();

		await makeRuntime( cli ).destroy( config );

		return cli.calls
			.filter(
				( args ) => args[ 0 ] === 'image' && args[ 1 ] === 'delete'
			)
			.map( ( args ) => args[ 2 ] );
	};

	const removed = await deletedImages( [] );
	const kept = await deletedImages( [
		{
			name: 'other-phpmyadmin',
			state: 'stopped',
			image: 'docker.io/library/phpmyadmin:latest',
		},
	] );

	assert.ok( removed.includes( 'phpmyadmin' ) );
	assert.equal( kept.includes( 'phpmyadmin' ), false );
} );

test( 'destroy keeps a pulled phpmyadmin image that this project never used', async () => {
	const deletedImages = async ( state ) => {
		const cli = fakeCLI();
		cli.listByLabels = async () => [];
		cli.imageExists = async () => true;
		cli.list = async () => [];
		const config = makeConfig( { stateDirectoryPath: projectState() } );
		fs.writeFileSync(
			path.join( config.stateDirectoryPath, 'environments.json' ),
			JSON.stringify( state )
		);

		await makeRuntime( cli ).destroy( config );

		return cli.calls
			.filter(
				( args ) => args[ 0 ] === 'image' && args[ 1 ] === 'delete'
			)
			.map( ( args ) => args[ 2 ] );
	};

	const unused = await deletedImages( { development: { mysql: 50001 } } );
	const recorded = await deletedImages( {
		development: { mysql: 50001 },
		tests: { mysql: 50002, phpmyadmin: 50012 },
	} );

	assert.equal( unused.includes( 'phpmyadmin' ), false );
	assert.equal(
		recorded.filter( ( reference ) => reference === 'phpmyadmin' ).length,
		1
	);
} );

test( 'getStatus reports the phpMyAdmin of each environment, null where it is off', async () => {
	const config = phpmyadminConfig();
	config.env.tests.phpmyadmin = false;
	const cli = fakeCLI();
	cli.listByLabels = async () => [
		runningRecord( 'example-project-phpmyadmin' ),
	];

	const status = await makeRuntime( cli ).getStatus( config );

	assert.deepEqual( status.environments.development.phpmyadmin, {
		running: true,
		container: 'example-project-phpmyadmin',
		url: 'http://localhost:50011',
		port: 50011,
	} );
	assert.equal( status.environments.tests.phpmyadmin, null );

	cli.listByLabels = async () => [];
	const stopped = await makeRuntime( cli ).getStatus( config );
	assert.deepEqual( stopped.environments.development.phpmyadmin, {
		running: false,
		container: 'example-project-phpmyadmin',
		url: null,
		port: null,
	} );
} );
