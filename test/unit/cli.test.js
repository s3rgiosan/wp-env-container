'use strict';
const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const fs = require( 'fs' );
const path = require( 'path' );
const readline = require( 'readline/promises' );
const { main, parseRunArgs } = require( '../../lib/cli' );
const { CommandRunningError } = require( '../../lib/runtime/apple-container' );
const { makeConfig } = require( '../helpers/config' );
const { makeTempDir } = require( '../helpers/temp' );

function harness( configOverrides = {} ) {
	const calls = [];
	const configs = [];
	const loadArgs = [];
	const out = { stdout: '', stderr: '', exitCodes: [] };
	const runtime = {
		getStatus: async () => ( {
			projectId: 'example-project',
			environments: {},
		} ),
	};
	for ( const name of [
		'start',
		'stop',
		'destroy',
		'cleanup',
		'clean',
		'run',
	] ) {
		runtime[ name ] = async ( ...args ) => {
			calls.push( [ name, ...args.slice( 1 ) ] );
			configs.push( args[ 0 ] );
			if ( name === 'start' ) {
				return { siteUrl: 'http://localhost:8888', testsUrl: null };
			}
			return name === 'run' ? 7 : undefined;
		};
	}
	const options = {
		runtime,
		loadConfig: async ( ...args ) => {
			loadArgs.push( ...args );
			return makeConfig( configOverrides );
		},
		stdout: { write: ( text ) => ( out.stdout += text ) },
		stderr: { write: ( text ) => ( out.stderr += text ) },
		exit: ( code ) => out.exitCodes.push( code ),
	};
	return { calls, configs, loadArgs, out, options };
}

async function runCli( args, configOverrides ) {
	const h = harness( configOverrides );
	await main( args, h.options );
	return h;
}

test( 'run hands the loaded project config to the runtime', async () => {
	const { configs } = await runCli( [
		'run',
		'--config',
		'custom.json',
		'tests-cli',
		'wp',
		'option',
		'list',
	] );

	assert.equal( typeof configs[ 0 ], 'object' );
	assert.ok( configs[ 0 ].projectId );
} );

test( 'run reads --config before and after the container', async () => {
	const before = await runCli( [
		'run',
		'--config',
		'custom.json',
		'tests-cli',
		'wp',
		'option',
		'list',
	] );
	const after = await runCli( [
		'run',
		'tests-cli',
		'--config',
		'custom.json',
		'wp',
		'option',
		'list',
	] );
	const equals = await runCli( [
		'run',
		'tests-cli',
		'--config=custom.json',
		'wp',
		'option',
		'list',
	] );

	for ( const h of [ before, after, equals ] ) {
		assert.equal( h.loadArgs[ 0 ].customConfigPath, 'custom.json' );
		assert.deepEqual( h.calls[ 0 ][ 1 ].command, [
			'wp',
			'option',
			'list',
		] );
	}
} );

test( 'run passes --config after the command to the command', async () => {
	const { calls, loadArgs } = await runCli( [
		'run',
		'cli',
		'wp',
		'--config',
		'x.json',
	] );

	assert.deepEqual( calls[ 0 ][ 1 ].command, [ 'wp', '--config', 'x.json' ] );
	assert.equal( loadArgs[ 0 ].customConfigPath, null );
} );

test( 'run reports a missing --env-cwd or --config value', async () => {
	for ( const args of [
		[ 'run', 'cli', '--env-cwd' ],
		[ 'run', '--env-cwd' ],
		[ 'run', 'cli', '--config' ],
		[ 'run', '--config' ],
	] ) {
		const { calls, out } = await runCli( args );
		const flag = args.includes( '--config' ) ? '--config' : '--env-cwd';

		assert.equal( out.stderr, `✖ Missing value for ${ flag }.\n` );
		assert.deepEqual( out.exitCodes, [ 1 ] );
		assert.equal( calls.length, 0 );
	}
} );

test( 'parseRunArgs throws on a missing value in the head and tail', () => {
	assert.throws(
		() => parseRunArgs( [ 'run', 'cli', '--env-cwd' ] ),
		/^Error: Missing value for --env-cwd\.$/
	);
	assert.throws(
		() => parseRunArgs( [ 'run', '--config' ] ),
		/^Error: Missing value for --config\.$/
	);
} );

test( 'run through the yargs definition prints the usage and exits 1', async () => {
	const { calls, out } = await runCli( [ 'run', '--no-debug', 'cli', 'ls' ] );

	assert.match(
		out.stderr,
		/^✖ Usage: wp-env-container run \[--config <file>\] \[--debug\] <container> /
	);
	assert.deepEqual( out.exitCodes, [ 1 ] );
	assert.equal( calls.length, 0 );
} );

test( 'run accepts a -- right after run', async () => {
	const { calls } = await runCli( [ 'run', '--', 'cli', 'ls' ] );

	assert.deepEqual( calls[ 0 ][ 1 ], {
		container: 'cli',
		command: [ 'ls' ],
		envCwd: null,
		xdebug: null,
	} );
} );

test( 'run passes a command and its flags through verbatim', async () => {
	const { calls, out } = await runCli( [
		'run',
		'tests-cli',
		'vendor/bin/phpunit',
		'--filter',
		'Foo',
	] );

	assert.deepEqual( calls[ 0 ].slice( 1 ), [
		{
			container: 'tests-cli',
			command: [ 'vendor/bin/phpunit', '--filter', 'Foo' ],
			envCwd: null,
			xdebug: null,
		},
	] );
	assert.deepEqual( out.exitCodes, [ 7 ] );
} );

test( 'run drops a -- separator before the command only', async () => {
	const separated = await runCli( [ 'run', 'cli', '--', '-x', 'arg' ] );
	const inside = await runCli( [ 'run', 'cli', 'git', 'log', '--', 'path' ] );

	assert.deepEqual( separated.calls[ 0 ][ 1 ].command, [ '-x', 'arg' ] );
	assert.deepEqual( inside.calls[ 0 ][ 1 ].command, [
		'git',
		'log',
		'--',
		'path',
	] );
} );

test( 'run passes --help, -h and --version to the command', async () => {
	for ( const flag of [ '--help', '-h', '--version' ] ) {
		const { calls, out } = await runCli( [
			'run',
			'tests-cli',
			'wp',
			flag,
		] );

		assert.deepEqual( calls[ 0 ][ 1 ].command, [ 'wp', flag ] );
		assert.equal( out.stdout, '' );
	}
} );

test( 'run reads --env-cwd before the container', async () => {
	const { calls } = await runCli( [
		'run',
		'--env-cwd=wp-content/plugins/x',
		'tests-cli',
		'ls',
		'-la',
	] );

	assert.deepEqual( calls[ 0 ][ 1 ], {
		container: 'tests-cli',
		command: [ 'ls', '-la' ],
		envCwd: 'wp-content/plugins/x',
		xdebug: null,
	} );
} );

test( 'run reads --env-cwd right after the container', async () => {
	const equals = await runCli( [
		'run',
		'tests-cli',
		'--env-cwd=wp-content/plugins/x',
		'composer',
		'install',
	] );
	const spaced = await runCli( [
		'run',
		'tests-cli',
		'--env-cwd',
		'x',
		'--',
		'ls',
		'-la',
	] );

	assert.deepEqual( equals.calls[ 0 ][ 1 ], {
		container: 'tests-cli',
		command: [ 'composer', 'install' ],
		envCwd: 'wp-content/plugins/x',
		xdebug: null,
	} );
	assert.deepEqual( spaced.calls[ 0 ][ 1 ], {
		container: 'tests-cli',
		command: [ 'ls', '-la' ],
		envCwd: 'x',
		xdebug: null,
	} );
} );

test( 'run reads --xdebug before the container', async () => {
	const flag = await runCli( [
		'run',
		'--xdebug',
		'tests-cli',
		'vendor/bin/phpunit',
	] );
	const modes = await runCli( [
		'run',
		'--xdebug=coverage,debug',
		'--env-cwd=x',
		'cli',
		'php',
		'-m',
	] );

	assert.deepEqual( flag.calls[ 0 ][ 1 ], {
		container: 'tests-cli',
		command: [ 'vendor/bin/phpunit' ],
		envCwd: null,
		xdebug: true,
	} );
	assert.deepEqual( modes.calls[ 0 ][ 1 ], {
		container: 'cli',
		command: [ 'php', '-m' ],
		envCwd: 'x',
		xdebug: 'coverage,debug',
	} );
} );

test( 'run reads --xdebug between the container and the command', async () => {
	const flag = await runCli( [
		'run',
		'tests-cli',
		'--xdebug',
		'--env-cwd',
		'x',
		'vendor/bin/phpunit',
	] );
	const modes = await runCli( [
		'run',
		'cli',
		'--xdebug=coverage,debug',
		'--',
		'php',
		'-m',
	] );

	assert.deepEqual( flag.calls[ 0 ][ 1 ], {
		container: 'tests-cli',
		command: [ 'vendor/bin/phpunit' ],
		envCwd: 'x',
		xdebug: true,
	} );
	assert.deepEqual( modes.calls[ 0 ][ 1 ], {
		container: 'cli',
		command: [ 'php', '-m' ],
		envCwd: null,
		xdebug: 'coverage,debug',
	} );
} );

test( 'run passes --xdebug after the command to the command', async () => {
	const { calls } = await runCli( [ 'run', 'cli', 'php', '--xdebug', '-m' ] );

	assert.deepEqual( calls[ 0 ][ 1 ].command, [ 'php', '--xdebug', '-m' ] );
	assert.equal( calls[ 0 ][ 1 ].xdebug, null );
} );

test( 'run passes --env-cwd after the command to the command', async () => {
	const { calls } = await runCli( [ 'run', 'cli', 'ls', '--env-cwd=x' ] );

	assert.deepEqual( calls[ 0 ][ 1 ].command, [ 'ls', '--env-cwd=x' ] );
	assert.equal( calls[ 0 ][ 1 ].envCwd, null );
} );

test( 'run without a command opens bash in cli containers and sh elsewhere', async () => {
	const cli = await runCli( [ 'run', 'cli' ] );
	const mysql = await runCli( [ 'run', 'mysql' ] );
	const testsMysql = await runCli( [ 'run', 'tests-mysql', '--', 'pwd' ] );
	const testsMysqlShell = await runCli( [ 'run', 'tests-mysql' ] );

	assert.deepEqual( cli.calls[ 0 ][ 1 ].command, [ 'bash' ] );
	assert.deepEqual( mysql.calls[ 0 ][ 1 ].command, [ 'sh' ] );
	assert.equal( testsMysql.calls[ 0 ][ 1 ].container, 'tests-mysql' );
	assert.deepEqual( testsMysql.calls[ 0 ][ 1 ].command, [ 'pwd' ] );
	assert.equal( testsMysqlShell.calls[ 0 ][ 1 ].container, 'tests-mysql' );
	assert.deepEqual( testsMysqlShell.calls[ 0 ][ 1 ].command, [ 'sh' ] );
	assert.equal( testsMysqlShell.calls[ 0 ][ 1 ].envCwd, null );
} );

test( 'parseRunArgs ignores other commands and a bare run', () => {
	assert.equal( parseRunArgs( [ 'start' ] ), null );
	assert.equal( parseRunArgs( [ 'run' ] ), null );
	assert.equal( parseRunArgs( [ 'run', '--help' ] ), null );
	assert.equal(
		parseRunArgs( [ '--config', 'a.json', 'run', 'cli', 'ls' ] ).config,
		'a.json'
	);
} );

test( 'a mistyped option on a regular command is rejected', async () => {
	const h = harness();

	await assert.rejects(
		main( [ 'start', '--updat' ], h.options ),
		/Unknown argument: updat/
	);
	assert.equal( h.calls.length, 0 );
} );

test( 'an unknown command is rejected', async () => {
	await assert.rejects(
		main( [ 'bogus' ], harness().options ),
		/Unknown argument: bogus/
	);
} );

function scriptProject() {
	const dir = makeTempDir( 'wpec-cli-' );
	return {
		dir: fs.realpathSync( dir ),
		marker: path.join( fs.realpathSync( dir ), 'marker.txt' ),
	};
}

test( 'lifecycle scripts run through a shell in the project directory', async ( t ) => {
	const { dir, marker } = scriptProject();
	t.after( () => fs.rmSync( dir, { recursive: true, force: true } ) );

	const { out } = await runCli( [ 'start' ], {
		configDirectoryPath: dir,
		lifecycleScripts: { afterStart: 'echo "$(pwd)" > marker.txt && true' },
	} );

	assert.equal( fs.readFileSync( marker, 'utf8' ).trim(), dir );
	assert.deepEqual( out.exitCodes, [ 0 ] );
} );

test( 'a failing lifecycle script fails the command', async ( t ) => {
	const { dir } = scriptProject();
	t.after( () => fs.rmSync( dir, { recursive: true, force: true } ) );

	const { out } = await runCli( [ 'start' ], {
		configDirectoryPath: dir,
		lifecycleScripts: { afterStart: 'exit 3' },
	} );

	assert.match( out.stderr, /afterStart script exited with 3/ );
	assert.deepEqual( out.exitCodes, [ 1 ] );
} );

test( '--no-scripts skips lifecycle scripts', async ( t ) => {
	const { dir, marker } = scriptProject();
	t.after( () => fs.rmSync( dir, { recursive: true, force: true } ) );

	const { out } = await runCli( [ 'start', '--no-scripts' ], {
		configDirectoryPath: dir,
		lifecycleScripts: { afterStart: 'touch marker.txt; exit 3' },
	} );

	assert.equal( fs.existsSync( marker ), false );
	assert.deepEqual( out.exitCodes, [ 0 ] );
} );

test( 'destroy without --force cancels in a non-interactive shell', async ( t ) => {
	const descriptor = Object.getOwnPropertyDescriptor(
		process.stdin,
		'isTTY'
	);
	Object.defineProperty( process.stdin, 'isTTY', {
		value: false,
		configurable: true,
	} );
	t.after( () => {
		if ( descriptor ) {
			Object.defineProperty( process.stdin, 'isTTY', descriptor );
		} else {
			delete process.stdin.isTTY;
		}
	} );

	const { calls, out } = await runCli( [ 'destroy' ] );

	assert.equal( calls.length, 0 );
	assert.match( out.stderr, /Cancelled/ );
	assert.deepEqual( out.exitCodes, [ 1 ] );
} );

test( 'destroy --force destroys without prompting', async () => {
	const { calls, out } = await runCli( [ 'destroy', '--force' ] );

	assert.equal( calls[ 0 ][ 0 ], 'destroy' );
	assert.deepEqual( out.exitCodes, [ 0 ] );
} );

function nonTTY( t ) {
	const descriptor = Object.getOwnPropertyDescriptor(
		process.stdin,
		'isTTY'
	);
	Object.defineProperty( process.stdin, 'isTTY', {
		value: false,
		configurable: true,
	} );
	t.after( () => {
		if ( descriptor ) {
			Object.defineProperty( process.stdin, 'isTTY', descriptor );
		} else {
			delete process.stdin.isTTY;
		}
	} );
}

function markerScripts( t, events ) {
	const { dir, marker } = scriptProject();
	t.after( () => fs.rmSync( dir, { recursive: true, force: true } ) );
	const lifecycleScripts = {};
	for ( const event of events ) {
		lifecycleScripts[ event ] = `echo ${ event } >> marker.txt`;
	}
	return {
		overrides: { configDirectoryPath: dir, lifecycleScripts },
		marker,
	};
}

test( 'reset defaults to development and runs afterReset', async ( t ) => {
	const { overrides, marker } = markerScripts( t, [
		'afterReset',
		'afterClean',
	] );

	const { calls, out } = await runCli( [ 'reset' ], overrides );

	assert.deepEqual( calls, [ [ 'clean', { environment: 'development' } ] ] );
	assert.equal( fs.readFileSync( marker, 'utf8' ).trim(), 'afterReset' );
	assert.deepEqual( out.exitCodes, [ 0 ] );
} );

test( 'reset and clean name the scope of the reset', async () => {
	const all = await runCli( [ 'reset', 'all' ] );
	const tests = await runCli( [ 'reset', 'tests' ] );
	const clean = await runCli( [ 'clean', 'all' ] );

	assert.equal( all.out.stdout, 'Reset both environments.\n' );
	assert.equal( tests.out.stdout, 'Reset the tests environment.\n' );
	assert.equal( clean.out.stdout, 'Reset both environments.\n' );
} );

test( 'reset --no-scripts skips the lifecycle script', async ( t ) => {
	const { overrides, marker } = markerScripts( t, [ 'afterReset' ] );

	const { calls } = await runCli(
		[ 'reset', 'tests', '--no-scripts' ],
		overrides
	);

	assert.deepEqual( calls, [ [ 'clean', { environment: 'tests' } ] ] );
	assert.equal( fs.existsSync( marker ), false );
} );

test( 'clean defaults to development, warns as deprecated and runs afterClean', async ( t ) => {
	const { overrides, marker } = markerScripts( t, [
		'afterReset',
		'afterClean',
	] );

	const { calls, out } = await runCli( [ 'clean' ], overrides );

	assert.deepEqual( calls, [ [ 'clean', { environment: 'development' } ] ] );
	assert.match(
		out.stderr,
		/The `clean` command is deprecated\. Use `reset` instead\./
	);
	assert.equal( fs.readFileSync( marker, 'utf8' ).trim(), 'afterClean' );
} );

test( 'cleanup without --force cancels in a non-interactive shell', async ( t ) => {
	nonTTY( t );

	const { calls, out } = await runCli( [ 'cleanup' ] );

	assert.equal( calls.length, 0 );
	assert.match( out.stderr, /Cancelled/ );
	assert.deepEqual( out.exitCodes, [ 1 ] );
} );

test( 'cleanup --force cleans up and runs afterCleanup', async ( t ) => {
	const { overrides, marker } = markerScripts( t, [
		'afterCleanup',
		'afterDestroy',
	] );

	const { calls, out } = await runCli( [ 'cleanup', '--force' ], overrides );

	assert.deepEqual( calls, [ [ 'cleanup' ] ] );
	assert.equal( fs.readFileSync( marker, 'utf8' ).trim(), 'afterCleanup' );
	assert.deepEqual( out.exitCodes, [ 0 ] );
} );

test( '--debug sets WP_ENV_CONTAINER_DEBUG', async ( t ) => {
	const previous = process.env.WP_ENV_CONTAINER_DEBUG;
	delete process.env.WP_ENV_CONTAINER_DEBUG;
	t.after( () => {
		if ( previous === undefined ) {
			delete process.env.WP_ENV_CONTAINER_DEBUG;
		} else {
			process.env.WP_ENV_CONTAINER_DEBUG = previous;
		}
	} );

	const status = await runCli( [ 'status', '--debug', '--json' ] );
	assert.equal( process.env.WP_ENV_CONTAINER_DEBUG, '1' );
	assert.equal(
		JSON.parse( status.out.stdout ).projectId,
		'example-project'
	);
	assert.equal( status.out.stderr, '' );
	assert.deepEqual( status.out.exitCodes, [ 0 ] );

	delete process.env.WP_ENV_CONTAINER_DEBUG;
	await runCli( [ 'stop' ] );
	assert.equal( process.env.WP_ENV_CONTAINER_DEBUG, undefined );

	await runCli( [ 'run', '--debug', 'cli', 'ls' ] );
	assert.equal( process.env.WP_ENV_CONTAINER_DEBUG, '1' );
} );

test( 'parseRunArgs reads --debug before and after the container, and keeps it after the command', () => {
	const before = parseRunArgs( [ 'run', '--debug', 'cli', 'ls' ] );
	const between = parseRunArgs( [ 'run', 'cli', '--debug', 'ls' ] );
	const after = parseRunArgs( [ 'run', 'cli', 'ls', '--debug' ] );

	assert.equal( before.debug, true );
	assert.deepEqual( before.command, [ 'ls' ] );
	assert.equal( between.debug, true );
	assert.deepEqual( between.command, [ 'ls' ] );
	assert.equal( after.debug, false );
	assert.deepEqual( after.command, [ 'ls', '--debug' ] );
} );

function answerOnTTY( t, answer ) {
	const descriptor = Object.getOwnPropertyDescriptor(
		process.stdin,
		'isTTY'
	);
	const original = readline.createInterface;
	const questions = [];
	Object.defineProperty( process.stdin, 'isTTY', {
		value: true,
		configurable: true,
	} );
	readline.createInterface = () => ( {
		question: async ( question ) => {
			questions.push( question );
			return answer;
		},
		close: () => {},
	} );
	t.after( () => {
		readline.createInterface = original;
		if ( descriptor ) {
			Object.defineProperty( process.stdin, 'isTTY', descriptor );
		} else {
			delete process.stdin.isTTY;
		}
	} );
	return questions;
}

test( 'cleanup and destroy proceed when the prompt is answered y', async ( t ) => {
	const questions = answerOnTTY( t, 'y\n' );

	const cleanup = await runCli( [ 'cleanup' ] );
	const destroy = await runCli( [ 'destroy' ] );

	assert.equal( questions.length, 2 );
	assert.match( questions[ 0 ], /\[y\/N\] $/ );
	assert.deepEqual( cleanup.calls, [ [ 'cleanup' ] ] );
	assert.deepEqual( destroy.calls, [ [ 'destroy' ] ] );
	assert.deepEqual( cleanup.out.exitCodes, [ 0 ] );
	assert.deepEqual( destroy.out.exitCodes, [ 0 ] );
} );

test( 'cleanup and destroy cancel when the prompt is answered n', async ( t ) => {
	answerOnTTY( t, 'n' );

	const cleanup = await runCli( [ 'cleanup' ] );
	const destroy = await runCli( [ 'destroy' ] );

	assert.equal( cleanup.calls.length, 0 );
	assert.equal( destroy.calls.length, 0 );
	assert.match( cleanup.out.stderr, /Cancelled/ );
	assert.match( destroy.out.stderr, /Cancelled/ );
	assert.deepEqual( cleanup.out.exitCodes, [ 1 ] );
	assert.deepEqual( destroy.out.exitCodes, [ 1 ] );
} );

test( 'start prints the phpMyAdmin URLs the runtime returns', async () => {
	const h = harness();
	h.options.runtime.start = async () => ( {
		siteUrl: 'http://localhost:8888',
		testsUrl: 'http://localhost:8889',
		phpmyadminUrl: 'http://localhost:50011',
		testsPhpmyadminUrl: 'http://localhost:50012',
	} );

	await main( [ 'start' ], h.options );

	assert.equal(
		h.out.stdout,
		[
			'WordPress development site started at http://localhost:8888',
			'WordPress test site started at http://localhost:8889',
			'phpMyAdmin started at http://localhost:50011',
			'phpMyAdmin for automated testing started at http://localhost:50012',
			'',
		].join( '\n' )
	);
} );

test( 'start passes --xdebug to the runtime and null without it', async () => {
	const runs = [
		[ [ 'start' ], { update: false, xdebug: null, autoPort: undefined } ],
		[
			[ 'start', '--xdebug' ],
			{ update: false, xdebug: '', autoPort: undefined },
		],
		[
			[ 'start', '--xdebug=profile,debug', '--update' ],
			{ update: true, xdebug: 'profile,debug', autoPort: undefined },
		],
		[
			[ 'start', '--xdebug=off' ],
			{ update: false, xdebug: null, autoPort: undefined },
		],
		[
			[ 'start', '--auto-port' ],
			{ update: false, xdebug: null, autoPort: true },
		],
		[
			[ 'start', '--no-auto-port' ],
			{ update: false, xdebug: null, autoPort: false },
		],
	];
	for ( const [ args, expected ] of runs ) {
		const { calls, out } = await runCli( args );
		assert.deepEqual( calls, [ [ 'start', expected ] ], args.join( ' ' ) );
		assert.deepEqual( out.exitCodes, [ 0 ] );
	}
} );

const STUB_STATUS = {
	projectId: 'example-project',
	stateDirectory: '/example/state',
	environments: {
		development: {
			running: true,
			container: 'example-project-wordpress',
			url: 'http://localhost:8888',
			port: 8888,
			wordpressVersion: '6.0',
			phpVersion: '8.3',
			image: 'wordpress:php8.3',
			xdebug: 'debug',
			database: {
				running: true,
				container: 'example-project-mysql',
				host: '192.168.64.2',
				port: 50001,
				image: 'mariadb:lts',
			},
		},
		tests: {
			running: true,
			container: 'example-project-tests-wordpress',
			url: 'http://localhost:8889',
			port: 8889,
			wordpressVersion: '6.0',
			phpVersion: '8.3',
			image: 'wordpress:php8.3',
			xdebug: 'off',
			database: {
				running: false,
				container: 'example-project-tests-mysql',
				host: null,
				port: null,
				image: 'mariadb:lts',
			},
		},
	},
};

test( 'status prints the Xdebug modes and the database port of each environment', async () => {
	const h = harness();
	h.options.runtime.getStatus = async () => STUB_STATUS;

	await main( [ 'status' ], h.options );

	assert.equal(
		h.out.stdout,
		[
			'Project     example-project',
			'development running  http://localhost:8888  WordPress 6.0, PHP 8.3, Xdebug debug',
			'            MariaDB running  mariadb:lts  port 50001',
			'tests       running  http://localhost:8889  WordPress 6.0, PHP 8.3, Xdebug off',
			'            MariaDB stopped  mariadb:lts',
			'',
		].join( '\n' )
	);
} );

test( 'status prints the phpMyAdmin state of the environments that have it', async () => {
	const h = harness();
	h.options.runtime.getStatus = async () => ( {
		...STUB_STATUS,
		environments: {
			development: {
				...STUB_STATUS.environments.development,
				phpmyadmin: {
					running: true,
					container: 'example-project-phpmyadmin',
					url: 'http://localhost:50011',
					port: 50011,
				},
			},
			tests: {
				...STUB_STATUS.environments.tests,
				phpmyadmin: {
					running: false,
					container: 'example-project-tests-phpmyadmin',
					url: null,
					port: null,
				},
			},
		},
	} );

	await main( [ 'status' ], h.options );

	assert.equal(
		h.out.stdout,
		[
			'Project     example-project',
			'development running  http://localhost:8888  WordPress 6.0, PHP 8.3, Xdebug debug',
			'            MariaDB running  mariadb:lts  port 50001',
			'            phpMyAdmin running  http://localhost:50011',
			'tests       running  http://localhost:8889  WordPress 6.0, PHP 8.3, Xdebug off',
			'            MariaDB stopped  mariadb:lts',
			'            phpMyAdmin stopped',
			'',
		].join( '\n' )
	);
} );

test( 'status --json prints the status with a database per environment', async () => {
	const h = harness();
	h.options.runtime.getStatus = async () => STUB_STATUS;

	await main( [ 'status', '--json' ], h.options );

	const printed = JSON.parse( h.out.stdout );
	assert.deepEqual( printed, STUB_STATUS );
	assert.equal( 'database' in printed, false );
} );

test( 'a failing start, reset or stop prints the message and exits 1 without a stack', async () => {
	const cases = [
		[ [ 'start' ], 'start', new Error( 'Example start failure.' ) ],
		[ [ 'reset' ], 'clean', new Error( 'Example reset failure.' ) ],
		[
			[ 'stop' ],
			'stop',
			new CommandRunningError( [
				{ name: 'example-project-tests-cli-1' },
			] ),
		],
	];

	for ( const [ args, method, error ] of cases ) {
		const h = harness();
		h.options.runtime[ method ] = async () => {
			throw error;
		};

		await main( args, h.options );

		assert.equal( h.out.stderr, `✖ ${ error.message }\n` );
		assert.deepEqual( h.out.exitCodes, [ 1 ] );
		assert.equal( h.out.stdout, '' );
	}
} );

test( 'a failing command prints the stack with --debug', async ( t ) => {
	const previous = process.env.WP_ENV_CONTAINER_DEBUG;
	delete process.env.WP_ENV_CONTAINER_DEBUG;
	t.after( () => {
		if ( previous === undefined ) {
			delete process.env.WP_ENV_CONTAINER_DEBUG;
		} else {
			process.env.WP_ENV_CONTAINER_DEBUG = previous;
		}
	} );
	const error = new Error( 'Example start failure.' );
	const h = harness();
	h.options.runtime.start = async () => {
		throw error;
	};

	await main( [ 'start', '--debug' ], h.options );

	assert.equal(
		h.out.stderr,
		`✖ Example start failure.\n${ error.stack }\n`
	);
	assert.deepEqual( h.out.exitCodes, [ 1 ] );
} );

test( 'status without phpMyAdmin prints null for it in the JSON and no line in the text', async () => {
	const status = {
		...STUB_STATUS,
		environments: {
			development: {
				...STUB_STATUS.environments.development,
				phpmyadmin: null,
			},
			tests: { ...STUB_STATUS.environments.tests, phpmyadmin: null },
		},
	};
	const json = harness();
	json.options.runtime.getStatus = async () => status;
	const text = harness();
	text.options.runtime.getStatus = async () => status;

	await main( [ 'status', '--json' ], json.options );
	await main( [ 'status' ], text.options );

	assert.deepEqual( JSON.parse( json.out.stdout ), status );
	assert.equal(
		text.out.stdout,
		[
			'Project     example-project',
			'development running  http://localhost:8888  WordPress 6.0, PHP 8.3, Xdebug debug',
			'            MariaDB running  mariadb:lts  port 50001',
			'tests       running  http://localhost:8889  WordPress 6.0, PHP 8.3, Xdebug off',
			'            MariaDB stopped  mariadb:lts',
			'',
		].join( '\n' )
	);
} );

test( 'run rejects tests-phpmyadmin with the runtime error and opens sh in phpmyadmin', async () => {
	const rejected = harness();
	const message =
		'Unknown container "tests-phpmyadmin". Use one of: cli, tests-cli, mysql, tests-mysql, phpmyadmin.';
	rejected.options.runtime.run = async () => {
		throw new Error( message );
	};
	await main( [ 'run', 'tests-phpmyadmin' ], rejected.options );

	assert.equal( rejected.out.stderr, `✖ ${ message }\n` );
	assert.deepEqual( rejected.out.exitCodes, [ 1 ] );

	const shell = await runCli( [ 'run', 'phpmyadmin' ] );

	assert.equal( shell.calls[ 0 ][ 1 ].container, 'phpmyadmin' );
	assert.deepEqual( shell.calls[ 0 ][ 1 ].command, [ 'sh' ] );
} );
