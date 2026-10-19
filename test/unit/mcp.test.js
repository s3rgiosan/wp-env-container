'use strict';
const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const { Client } = require( '@modelcontextprotocol/sdk/client/index.js' );
const {
	InMemoryTransport,
} = require( '@modelcontextprotocol/sdk/inMemory.js' );
const { createServer } = require( '../../lib/mcp/server' );
const {
	AppleContainerRuntime,
	EnvironmentNotRunningError,
} = require( '../../lib/runtime/apple-container' );
const { makeConfig } = require( '../helpers/config' );
const { makeTempDir } = require( '../helpers/temp' );

function fakeRuntime( overrides = {} ) {
	const calls = [];
	const record =
		( name ) =>
		( ...args ) => {
			calls.push( [ name, ...args.slice( 1 ) ] );
			return overrides[ name ] ? overrides[ name ]( ...args ) : undefined;
		};
	return {
		calls,
		getStatus: record( 'getStatus' ),
		readLogs: record( 'readLogs' ),
		wpCli: record( 'wpCli' ),
		phpunit: record( 'phpunit' ),
		clean: record( 'clean' ),
	};
}

async function connect( runtime, config = makeConfig() ) {
	const server = createServer( { runtime, getConfig: async () => config } );
	const client = new Client( { name: 'test', version: '0.0.0' } );
	const [ clientTransport, serverTransport ] =
		InMemoryTransport.createLinkedPair();
	await Promise.all( [
		server.connect( serverTransport ),
		client.connect( clientTransport ),
	] );
	return client;
}

function parse( result ) {
	return JSON.parse( result.content[ 0 ].text );
}

test( 'lists the five tests-environment tools', async () => {
	const client = await connect( fakeRuntime() );
	const { tools } = await client.listTools();

	assert.deepEqual( tools.map( ( tool ) => tool.name ).sort(), [
		'tests_logs',
		'tests_phpunit',
		'tests_reset',
		'tests_status',
		'tests_wp_cli',
	] );
} );

test( 'tests_status returns only the tests environment and database', async () => {
	const runtime = fakeRuntime( {
		getStatus: async () => ( {
			projectId: 'example-project',
			environments: {
				development: {
					running: true,
					database: { running: true, port: 50001 },
				},
				tests: {
					running: true,
					port: 8889,
					database: { running: true, port: 50002 },
				},
			},
		} ),
	} );
	const client = await connect( runtime );

	const result = await client.callTool( {
		name: 'tests_status',
		arguments: {},
	} );

	assert.deepEqual( parse( result ), {
		projectId: 'example-project',
		database: { running: true, port: 50002 },
		tests: { running: true, port: 8889 },
	} );
} );

test( 'tests_status includes the tests phpMyAdmin, null when it is off', async () => {
	const phpmyadmin = {
		running: true,
		container: 'example-project-tests-phpmyadmin',
		url: 'http://localhost:50012',
		port: 50012,
	};
	const status = ( value ) => ( {
		projectId: 'example-project',
		environments: {
			tests: {
				running: true,
				port: 8889,
				database: { running: true, port: 50002 },
				phpmyadmin: value,
			},
		},
	} );

	for ( const value of [ phpmyadmin, null ] ) {
		const client = await connect(
			fakeRuntime( { getStatus: async () => status( value ) } )
		);

		const result = await client.callTool( {
			name: 'tests_status',
			arguments: {},
		} );

		assert.deepEqual( parse( result ), {
			projectId: 'example-project',
			database: { running: true, port: 50002 },
			phpmyadmin: value,
			tests: { running: true, port: 8889 },
		} );
	}
} );

test( 'tests_wp_cli passes arguments through and flags a non-zero exit', async () => {
	const runtime = fakeRuntime( {
		wpCli: async () => ( {
			exitCode: 1,
			stdout: '',
			stderr: 'Error: nope',
		} ),
	} );
	const client = await connect( runtime );

	const result = await client.callTool( {
		name: 'tests_wp_cli',
		arguments: { args: [ 'option', 'get', 'missing' ], cwd: 'wp-content' },
	} );

	assert.equal( result.isError, true );
	assert.deepEqual( runtime.calls[ 0 ].slice( 1 ), [
		'tests',
		[ 'option', 'get', 'missing' ],
		{ cwd: 'wp-content', timeoutMs: 300000 },
	] );
} );

test( 'tests_phpunit converts the timeout and applies defaults', async () => {
	const runtime = fakeRuntime( {
		phpunit: async () => ( { passed: true, summary: { tests: 1 } } ),
	} );
	const client = await connect( runtime );

	const result = await client.callTool( {
		name: 'tests_phpunit',
		arguments: { filter: 'test_answer' },
	} );

	assert.equal( parse( result ).passed, true );
	assert.deepEqual( runtime.calls[ 0 ][ 1 ], {
		filter: 'test_answer',
		extraArgs: [],
		timeoutMs: 600000,
	} );
} );

test( 'tests_phpunit forwards a valid xdebug mode', async () => {
	const runtime = fakeRuntime( {
		phpunit: async () => ( { passed: true, summary: null } ),
	} );
	const client = await connect( runtime );

	await client.callTool( {
		name: 'tests_phpunit',
		arguments: { xdebug: 'coverage,debug' },
	} );

	assert.deepEqual( runtime.calls[ 0 ][ 1 ], {
		extraArgs: [],
		xdebug: 'coverage,debug',
		timeoutMs: 600000,
	} );
} );

test( 'tests_phpunit returns isError for an invalid xdebug mode', async () => {
	const runtime = fakeRuntime();
	const client = await connect( runtime );

	const result = await client.callTool( {
		name: 'tests_phpunit',
		arguments: { xdebug: 'bogus' },
	} );

	assert.equal( result.isError, true );
	assert.match(
		result.content[ 0 ].text,
		/^Invalid Xdebug mode "bogus"\. Use a comma-separated list of: off, develop/
	);
	assert.equal( runtime.calls.length, 0 );
} );

test( 'tests_reset cleans only the tests environment', async () => {
	const runtime = fakeRuntime();
	const client = await connect( runtime );

	await client.callTool( { name: 'tests_reset', arguments: {} } );

	assert.deepEqual( runtime.calls[ 0 ][ 1 ], { environment: 'tests' } );
} );

test( 'a runtime error becomes a readable isError result', async () => {
	const runtime = fakeRuntime( {
		readLogs: async () => {
			throw new EnvironmentNotRunningError( 'tests' );
		},
	} );
	const client = await connect( runtime );

	const result = await client.callTool( {
		name: 'tests_logs',
		arguments: {},
	} );

	assert.equal( result.isError, true );
	assert.match(
		result.content[ 0 ].text,
		/not running.*wp-env-container start/
	);
	assert.deepEqual( runtime.calls[ 0 ].slice( 1 ), [
		'tests',
		{ source: 'apache', lines: 100 },
	] );
} );

test( 'tests_phpunit returns isError when the run is red', async () => {
	const runtime = fakeRuntime( {
		phpunit: async () => ( {
			passed: false,
			timedOut: false,
			summary: { tests: 2, failures: 1 },
		} ),
	} );
	const client = await connect( runtime );

	const result = await client.callTool( {
		name: 'tests_phpunit',
		arguments: {},
	} );

	assert.equal( result.isError, true );
	assert.equal( parse( result ).passed, false );
} );

test( 'tests_phpunit is not an error when the run passes', async () => {
	const runtime = fakeRuntime( {
		phpunit: async () => ( { passed: true, summary: null } ),
	} );
	const client = await connect( runtime );

	const result = await client.callTool( {
		name: 'tests_phpunit',
		arguments: {},
	} );

	assert.equal( result.isError, false );
} );

test( 'tests_status returns isError with the full status when tests are not running', async () => {
	const runtime = fakeRuntime( {
		getStatus: async () => ( {
			projectId: 'example-project',
			environments: {
				tests: {
					running: false,
					port: 8889,
					database: { running: false },
				},
			},
		} ),
	} );
	const client = await connect( runtime );

	const result = await client.callTool( {
		name: 'tests_status',
		arguments: {},
	} );

	assert.equal( result.isError, true );
	assert.equal( parse( result ).tests.running, false );
	assert.equal( parse( result ).projectId, 'example-project' );
} );

test( 'tests_status returns the disabled error when testsEnvironment is false', async () => {
	const runtime = fakeRuntime();
	const client = await connect(
		runtime,
		makeConfig( { testsEnvironment: false } )
	);

	const result = await client.callTool( {
		name: 'tests_status',
		arguments: {},
	} );

	assert.equal( result.isError, true );
	assert.match( result.content[ 0 ].text, /testsEnvironment/ );
	assert.deepEqual( runtime.calls, [] );
} );

test( 'tests_status is an error with the database state when only the tests site is down', async () => {
	const runtime = fakeRuntime( {
		getStatus: async () => ( {
			projectId: 'example-project',
			environments: {
				tests: {
					running: false,
					port: 8889,
					database: { running: true, port: 50002 },
				},
			},
		} ),
	} );
	const client = await connect( runtime );

	const result = await client.callTool( {
		name: 'tests_status',
		arguments: {},
	} );

	assert.equal( result.isError, true );
	assert.equal( parse( result ).tests.running, false );
	assert.equal( parse( result ).database.running, true );
} );

test( 'tests_status is not an error when tests are running', async () => {
	const runtime = fakeRuntime( {
		getStatus: async () => ( {
			projectId: 'example-project',
			environments: {
				tests: { running: true, database: { running: true } },
			},
		} ),
	} );
	const client = await connect( runtime );

	const result = await client.callTool( {
		name: 'tests_status',
		arguments: {},
	} );

	assert.equal( result.isError, false );
} );

test( 'tests_wp_cli forwards timeoutSeconds as timeoutMs and flags a timeout', async () => {
	const runtime = fakeRuntime( {
		wpCli: async () => ( {
			exitCode: 0,
			stdout: '',
			stderr: '',
			timedOut: true,
		} ),
	} );
	const client = await connect( runtime );

	const result = await client.callTool( {
		name: 'tests_wp_cli',
		arguments: { args: [ 'cron', 'event', 'run' ], timeoutSeconds: 45 },
	} );

	assert.equal( result.isError, true );
	assert.equal( runtime.calls[ 0 ][ 3 ].timeoutMs, 45000 );
} );

test( 'tests_reset returns isError when the tests environment is disabled', async () => {
	const runtime = fakeRuntime();
	const client = await connect(
		runtime,
		makeConfig( { testsEnvironment: false } )
	);

	const result = await client.callTool( {
		name: 'tests_reset',
		arguments: {},
	} );

	assert.equal( result.isError, true );
	assert.match( result.content[ 0 ].text, /tests environment is disabled/ );
	assert.equal( runtime.calls.length, 0 );
} );

test( 'tests_logs forwards the debug_log source', async () => {
	const runtime = fakeRuntime( { readLogs: async () => 'a line' } );
	const client = await connect( runtime );

	const result = await client.callTool( {
		name: 'tests_logs',
		arguments: { source: 'debug_log', lines: 5 },
	} );

	assert.equal( result.content[ 0 ].text, 'a line' );
	assert.deepEqual( runtime.calls[ 0 ].slice( 1 ), [
		'tests',
		{ source: 'debug_log', lines: 5 },
	] );
} );

test( 'input bounds are enforced and name the offending field', async () => {
	const runtime = fakeRuntime();
	const client = await connect( runtime );
	const cases = [
		[ 'tests_logs', { lines: 0 }, 'lines' ],
		[ 'tests_logs', { lines: 2001 }, 'lines' ],
		[ 'tests_phpunit', { timeoutSeconds: 5 }, 'timeoutSeconds' ],
		[
			'tests_wp_cli',
			{ args: [ 'option', 'list' ], timeoutSeconds: 0 },
			'timeoutSeconds',
		],
		[
			'tests_wp_cli',
			{ args: [ 'option', 'list' ], timeoutSeconds: 3601 },
			'timeoutSeconds',
		],
	];

	for ( const [ name, args, field ] of cases ) {
		const outcome = await client
			.callTool( { name, arguments: args } )
			.catch( ( error ) => error );
		const message =
			outcome instanceof Error
				? outcome.message
				: outcome.content[ 0 ].text;
		const rejected = outcome instanceof Error || outcome.isError === true;

		assert.ok( rejected, `${ name } ${ JSON.stringify( args ) }` );
		assert.match(
			message,
			new RegExp( field ),
			`${ name } ${ JSON.stringify( args ) }`
		);
	}
	assert.equal( runtime.calls.length, 0 );
} );

test( 'tests_reset returns isError while a command runs in tests-cli', async () => {
	const calls = [];
	const cli = {
		listByLabels: async () => [
			{
				name: 'example-project-phpunit-a1b2c3',
				state: 'running',
				labels: {
					'dev.wp-env-container.project': 'example-project',
					'dev.wp-env-container.role': 'cli',
					'dev.wp-env-container.env': 'tests',
				},
				ports: [],
			},
		],
		exec: async ( args ) => {
			calls.push( args );
			return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
		},
	};
	const runtime = new AppleContainerRuntime( { cli, log: () => {} } );
	const config = makeConfig( {
		stateDirectoryPath: makeTempDir( 'wpec-mcp-' ),
	} );
	const client = await connect( runtime, config );

	const result = await client.callTool( {
		name: 'tests_reset',
		arguments: {},
	} );

	assert.equal( result.isError, true );
	assert.equal(
		result.content[ 0 ].text,
		'A command is still running in tests-cli (example-project-phpunit-a1b2c3). Wait for it to finish or stop it with `container stop example-project-phpunit-a1b2c3`.'
	);
	assert.deepEqual( calls, [] );
} );
