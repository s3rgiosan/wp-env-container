'use strict';
/**
 * End-to-end run against Apple `container`: start the fixture plugin's
 * environments, drive the MCP tools over stdio, then stop and clean up.
 * Opt-in with WP_ENV_CONTAINER_E2E=1; needs macOS 26 and network access.
 */
const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const { execFile } = require( 'child_process' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );
const { promisify } = require( 'util' );
const { Client } = require( '@modelcontextprotocol/sdk/client/index.js' );
const {
	StdioClientTransport,
} = require( '@modelcontextprotocol/sdk/client/stdio.js' );

const execFileAsync = promisify( execFile );
const ROOT = path.resolve( __dirname, '..', '..' );
const BIN = path.join( ROOT, 'bin', 'wp-env-container' );
const CONTAINER_BIN =
	process.env.WP_ENV_CONTAINER_BIN || '/usr/local/bin/container';
const FIXTURE = path.join( ROOT, 'test', 'fixtures', 'sample-plugin' );
const PORT = Number( process.env.WP_ENV_PORT || 8888 );
const TESTS_PORT = Number( process.env.WP_ENV_TESTS_PORT || 8889 );

const enabled = process.env.WP_ENV_CONTAINER_E2E === '1';

function cli( env, ...args ) {
	return execFileAsync( BIN, args, {
		cwd: FIXTURE,
		env,
		maxBuffer: 64 * 1024 * 1024,
	} );
}

async function projectContainers() {
	const { stdout } = await execFileAsync( CONTAINER_BIN, [
		'list',
		'--all',
		'--format',
		'json',
	] );
	return JSON.parse( stdout ).filter( ( record ) =>
		record.configuration?.labels?.[
			'dev.wp-env-container.project'
		]?.includes( 'sample-plugin' )
	);
}

function parse( result ) {
	return JSON.parse( result.content[ 0 ].text );
}

test(
	'start, MCP tools, stop and cleanup',
	{ skip: ! enabled, timeout: 20 * 60 * 1000 },
	async ( t ) => {
		const home = fs.mkdtempSync(
			path.join( os.tmpdir(), 'wp-env-container-e2e-' )
		);
		const env = {
			...process.env,
			WP_ENV_CONTAINER_HOME: home,
			WP_ENV_PHP_VERSION: process.env.WP_ENV_PHP_VERSION || '8.3',
		};
		const run = ( ...args ) => cli( env, ...args );
		const removeHome = () =>
			fs.rmSync( home, { recursive: true, force: true } );
		// Covers a run that is killed before the after hook finishes.
		process.once( 'exit', removeHome );
		t.after( async () => {
			try {
				await run( 'cleanup', '--force' ).catch( () => {} );
			} finally {
				removeHome();
				process.removeListener( 'exit', removeHome );
			}
		} );

		const started = await run( 'start' );
		assert.match(
			started.stdout,
			new RegExp(
				`development site started at http://localhost:${ PORT }\n`
			)
		);
		assert.match(
			started.stdout,
			new RegExp(
				`test site started at http://localhost:${ TESTS_PORT }\n`
			)
		);

		const roles = ( await projectContainers() )
			.filter(
				( { configuration } ) =>
					configuration.labels[ 'dev.wp-env-container.role' ] !==
					'cli'
			)
			.map( ( { configuration } ) =>
				configuration.id.slice(
					configuration.labels[ 'dev.wp-env-container.project' ]
						.length + 1
				)
			)
			.sort();
		assert.deepEqual( roles, [
			'mysql',
			'tests-mysql',
			'tests-wordpress',
			'wordpress',
		] );

		const startedStatus = JSON.parse(
			( await run( 'status', '--json' ) ).stdout
		);
		assert.equal( startedStatus.environments.development.phpmyadmin, null );
		assert.equal( startedStatus.environments.tests.phpmyadmin, null );

		for ( const port of [ PORT, TESTS_PORT ] ) {
			const response = await fetch( `http://localhost:${ port }/` );
			assert.equal( response.status, 200, `port ${ port }` );
		}

		const builderResult = await execFileAsync( CONTAINER_BIN, [
			'builder',
			'status',
		] ).catch( ( error ) => error );
		const builderOutput = [ builderResult.stdout, builderResult.stderr ]
			.filter( Boolean )
			.join( '\n' )
			.trim();
		assert.notEqual( builderOutput, '', 'builder status prints something' );
		assert.match(
			builderOutput,
			/\b(stopped|not running|not found)\b/i,
			'BuildKit VM is stopped after the build'
		);
		assert.doesNotMatch(
			builderOutput.replace( /\bnot running\b/gi, '' ),
			/\brunning\b/i
		);

		await run(
			'run',
			'tests-cli',
			'--env-cwd=wp-content/plugins/sample-plugin',
			'composer',
			'install',
			'--no-interaction',
			'--no-progress'
		);

		const resetTests = await run( 'reset', 'tests' );
		assert.ok( resetTests.stdout.length > 0 );

		const client = new Client( { name: 'e2e', version: '0.0.0' } );
		await client.connect(
			new StdioClientTransport( {
				command: BIN,
				args: [ 'mcp', '--project', FIXTURE ],
				env,
			} )
		);
		t.after( () => client.close() );
		const call = ( name, args = {} ) =>
			client.callTool( { name, arguments: args }, undefined, {
				timeout: 10 * 60 * 1000,
			} );

		const status = parse( await call( 'tests_status' ) );
		assert.equal( status.tests.running, true );
		assert.equal( status.database.running, true );
		assert.match( status.database.container, /-tests-mysql$/ );
		assert.ok( status.database.port > 0, 'the tests database has a port' );
		assert.equal( status.tests.image, 'wordpress:php8.3' );
		assert.equal( status.phpmyadmin, null );

		const php = await call( 'tests_wp_cli', {
			args: [
				'eval',
				'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;',
			],
		} );
		assert.equal( parse( php ).stdout.trim(), '8.3' );

		const active = parse(
			await call( 'tests_wp_cli', {
				args: [ 'plugin', 'is-active', 'sample-plugin' ],
			} )
		);
		assert.equal( active.exitCode, 0 );

		const phpunit = parse( await call( 'tests_phpunit' ) );
		assert.equal( phpunit.passed, true, phpunit.output );
		assert.equal( phpunit.phpunit, 'vendor/bin/phpunit' );
		assert.equal( phpunit.summary.tests, 2 );

		const filtered = parse(
			await call( 'tests_phpunit', { filter: 'test_answer' } )
		);
		assert.equal( filtered.summary.tests, 1 );

		const coverage = parse(
			await call( 'tests_phpunit', { extraArgs: [ '--coverage-text' ] } )
		);
		assert.equal( coverage.passed, true, coverage.output );
		assert.match( coverage.output, /Code Coverage Report:/ );

		await call( 'tests_wp_cli', {
			args: [ 'option', 'update', 'wpec_marker', 'before-reset' ],
		} );
		const reset = await call( 'tests_reset' );
		assert.ok( ! reset.isError, reset.content[ 0 ].text );
		const marker = parse(
			await call( 'tests_wp_cli', {
				args: [ 'option', 'get', 'wpec_marker' ],
			} )
		);
		assert.notEqual(
			marker.exitCode,
			0,
			'the option is gone after the reset'
		);

		const developmentMarker = await run(
			'run',
			'cli',
			'wp',
			'option',
			'get',
			'siteurl'
		);
		assert.equal(
			developmentMarker.stdout.trim(),
			`http://localhost:${ PORT }`,
			'development is untouched'
		);

		const logs = await call( 'tests_logs', { lines: 5 } );
		assert.ok( ! logs.isError );

		await run( 'stop' );
		const afterStop = await projectContainers();
		assert.equal( afterStop.length, 0 );
		const stopped = await call( 'tests_wp_cli', {
			args: [ 'option', 'get', 'siteurl' ],
		} );
		assert.equal( stopped.isError, true );
		assert.match( stopped.content[ 0 ].text, /not running/ );

		await run( 'cleanup', '--force' );
		const projectDirectories = fs
			.readdirSync( home )
			.filter( ( name ) => name.startsWith( 'sample-plugin' ) );
		assert.deepEqual(
			projectDirectories,
			[],
			'the project state directory is gone'
		);
	}
);
