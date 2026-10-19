'use strict';
const { spawn } = require( 'child_process' );
const readline = require( 'readline/promises' );
const yargs = require( 'yargs' );
const { loadProjectConfig } = require( './config' );
const { isDebugEnabled } = require( './debug' );
const { AppleContainerRuntime } = require( './runtime/apple-container' );

/**
 * Runs a `.wp-env.json` lifecycle script (e.g. `afterStart`) through a shell
 * in the project directory. A non-zero exit rejects.
 * @param {Object} config Project configuration holding `lifecycleScripts`.
 * @param {string} event  Script name, e.g. `afterStart`.
 * @return {Promise<void>} Resolves when the script finishes.
 */
function runLifecycleScript( config, event ) {
	const script = config.lifecycleScripts?.[ event ];
	if ( ! script ) {
		return Promise.resolve();
	}
	return new Promise( ( resolve, reject ) => {
		const child = spawn( script, {
			cwd: config.configDirectoryPath,
			shell: true,
			stdio: 'inherit',
		} );
		child.on( 'error', reject );
		child.on( 'close', ( code ) =>
			code === 0
				? resolve()
				: reject(
						new Error( `${ event } script exited with ${ code }.` )
					)
		);
	} );
}

async function confirm( question ) {
	if ( ! process.stdin.isTTY ) {
		return false;
	}
	const prompt = readline.createInterface( {
		input: process.stdin,
		output: process.stderr,
	} );
	const answer = await prompt.question( `${ question } [y/N] ` );
	prompt.close();
	return /^y(es)?$/i.test( answer.trim() );
}

const RUN_USAGE =
	'Usage: wp-env-container run [--config <file>] [--debug] <container> [--env-cwd <dir>] [--xdebug[=<modes>]] [command..]';

/**
 * Reads one `run` option at `args[ index ]` into `state`.
 *
 * @param {string[]} args  Arguments.
 * @param {number}   index Position of the candidate option.
 * @param {Object}   state Receives `config`, `envCwd`, `xdebug` and `debug`.
 * @return {number} Arguments consumed; 0 when the token is not a `run` option.
 */
function readRunOption( args, index, state ) {
	const token = args[ index ];
	switch ( token ) {
		case '--xdebug':
			state.xdebug = true;
			return 1;
		case '--debug':
			state.debug = true;
			return 1;
		case '--config':
		case '--env-cwd': {
			if ( index + 1 >= args.length ) {
				throw new Error( `Missing value for ${ token }.` );
			}
			state[ token === '--config' ? 'config' : 'envCwd' ] =
				args[ index + 1 ];
			return 2;
		}
		default:
			break;
	}
	if ( token.startsWith( '--xdebug=' ) ) {
		state.xdebug = token.slice( '--xdebug='.length );
		return 1;
	}
	if ( token.startsWith( '--config=' ) ) {
		state.config = token.slice( '--config='.length );
		return 1;
	}
	if ( token.startsWith( '--env-cwd=' ) ) {
		state.envCwd = token.slice( '--env-cwd='.length );
		return 1;
	}
	return 0;
}

/**
 * Splits the arguments of `run` so the container command receives its
 * arguments untouched, including `--help`, `-h` and `--version`. `--config`,
 * `--env-cwd`, `--debug` and `--xdebug[=<modes>]` are read before the
 * container name or between it and the command. A `--` right after `run` or
 * right before the command ends these options and is dropped.
 *
 * @param {string[]} rawArgs Raw arguments without the node and script paths.
 * @return {?{config: ?string, container: string, envCwd: ?string, xdebug: ?(true|string), debug: boolean, command: string[]}}
 *         Null when the arguments are not a complete `run` invocation.
 * @throws {Error} When `--config` or `--env-cwd` has no value.
 */
function parseRunArgs( rawArgs ) {
	const args = rawArgs.map( String );
	const state = { config: null, envCwd: null, xdebug: null, debug: false };
	let index = 0;
	let seenRun = false;

	while ( index < args.length ) {
		const token = args[ index ];
		const consumed = readRunOption( args, index, state );
		if ( consumed ) {
			index += consumed;
		} else if ( ! seenRun && token === 'run' ) {
			seenRun = true;
			index += 1;
		} else if ( seenRun && token === '--' ) {
			index += 1;
		} else if ( seenRun && ! token.startsWith( '-' ) ) {
			return parseRunTail( args.slice( index + 1 ), {
				...state,
				container: token,
			} );
		} else {
			return null;
		}
	}
	return null;
}

/**
 * Reads run options between the container name and the command, then takes
 * the rest as the command.
 * @param {string[]} rest   Arguments after the container name.
 * @param {Object}   result Options parsed so far.
 * @return {Object} The parsed options plus the container `command`.
 */
function parseRunTail( rest, result ) {
	const state = { ...result };
	let index = 0;
	while ( index < rest.length ) {
		const consumed = readRunOption( rest, index, state );
		if ( ! consumed ) {
			break;
		}
		index += consumed;
	}
	if ( rest[ index ] === '--' ) {
		index += 1;
	}
	return { ...state, command: rest.slice( index ) };
}

/**
 * Turns on debug output for everything constructed afterwards: the
 * `container` wrapper, git commands, the config and error stack traces.
 */
function enableDebug() {
	process.env.WP_ENV_CONTAINER_DEBUG = '1';
}

function defaultIO() {
	return {
		stdout: process.stdout,
		stderr: process.stderr,
		exit: ( code ) => {
			process.exitCode = code;
		},
	};
}

/**
 * Wraps a command handler: loads the config, runs the handler and maps
 * errors to a message and a non-zero exit code.
 * @param {Object}                                                                deps    CLI dependencies: `loadConfig`, `runtime`, `stderr` and `exit`.
 * @param {(context: {argv: Object, config: Object, runtime: Object}) => unknown} handler Receives the parsed arguments, config and runtime.
 * @return {(argv: Object) => Promise<void>} Yargs command handler.
 */
function command( deps, handler ) {
	return async ( argv ) => {
		try {
			const config = await deps.loadConfig( {
				customConfigPath: argv.config || null,
			} );
			const runtime = deps.runtime || new AppleContainerRuntime();
			const exitCode = await handler( { argv, config, runtime } );
			deps.exit( exitCode ?? 0 );
		} catch ( error ) {
			deps.stderr.write( `✖ ${ error.message }\n` );
			if ( isDebugEnabled() ) {
				deps.stderr.write( `${ error.stack }\n` );
			}
			deps.exit( 1 );
		}
	};
}

/**
 * Resets the databases of the chosen environment, then runs the lifecycle
 * script named `event`.
 * @param {{write: (text: string) => unknown}} stdout          Writable for normal output.
 * @param {Object}                             context         Command context.
 * @param {Object}                             context.argv    Parsed command arguments.
 * @param {Object}                             context.config  Project configuration.
 * @param {Object}                             context.runtime Container runtime.
 * @param {string}                             event           Lifecycle script name.
 * @return {Promise<void>} Resolves when the reset and script finish.
 */
async function resetEnvironment( stdout, { argv, config, runtime }, event ) {
	await runtime.clean( config, { environment: argv.environment } );
	const scope =
		argv.environment === 'all'
			? 'both environments'
			: `the ${ argv.environment } environment`;
	stdout.write( `Reset ${ scope }.\n` );
	if ( argv.scripts ) {
		await runLifecycleScript( config, event );
	}
}

async function runInContainer( {
	config,
	runtime,
	container,
	command: commandArgs,
	envCwd,
	xdebug = null,
} ) {
	const args = [ ...commandArgs ];
	if ( ! args.length ) {
		args.push( container.endsWith( 'cli' ) ? 'bash' : 'sh' );
	}
	return runtime.run( config, { container, command: args, envCwd, xdebug } );
}

/**
 * Runs the CLI.
 *
 * @param {string[]}                                                  args                 Arguments without the node and script paths.
 * @param {Object}                                                    [options]
 * @param {Object}                                                    [options.runtime]    Runtime to use. Defaults to `AppleContainerRuntime`.
 * @param {(options: {customConfigPath: ?string}) => Promise<Object>} [options.loadConfig] Config loader. Defaults to `loadProjectConfig`.
 * @param {Object}                                                    [options.stdout]     Writable for normal output.
 * @param {Object}                                                    [options.stderr]     Writable for messages.
 * @param {(code: number) => void}                                    [options.exit]       Receives the exit code.
 * @return {Promise<void>}
 */
async function main( args, options = {} ) {
	const deps = { loadConfig: loadProjectConfig, ...defaultIO(), ...options };
	const { stdout, stderr } = deps;

	let run;
	try {
		run = parseRunArgs( args );
	} catch ( error ) {
		stderr.write( `✖ ${ error.message }\n` );
		deps.exit( 1 );
		return;
	}
	if ( run ) {
		if ( run.debug ) {
			enableDebug();
		}
		const handler = command( deps, ( context ) =>
			runInContainer( { ...run, ...context } )
		);
		return handler( { config: run.config } );
	}

	return yargs( args )
		.scriptName( 'wp-env-container' )
		.usage( '$0 <command>\n\nRun wp-env environments on Apple container.' )
		.parserConfiguration( { 'populate--': true } )
		.option( 'config', {
			type: 'string',
			describe: 'Path to a custom .wp-env.json configuration file.',
		} )
		.option( 'debug', {
			type: 'boolean',
			default: false,
			describe:
				'Print each container and git command, and error stack traces.',
		} )
		.middleware( ( argv ) => {
			if ( argv.debug ) {
				enableDebug();
			}
		}, true )
		.command(
			'start',
			'Start WordPress for development on port 8888 (tests on 8889).',
			( builder ) =>
				builder
					.option( 'update', {
						type: 'boolean',
						default: false,
						describe:
							'Download sources, update images and reconfigure WordPress.',
					} )
					.option( 'xdebug', {
						type: 'string',
						describe:
							'Load Xdebug in the WordPress containers. Takes a comma-separated mode list; defaults to debug. Without it, or with off, Xdebug is off.',
					} )
					.option( 'auto-port', {
						type: 'boolean',
						describe:
							'Move a busy WordPress port to the next free one. Overrides the .wp-env.json "autoPort" setting; off when CI is set.',
					} )
					.option( 'scripts', {
						type: 'boolean',
						default: true,
						describe: 'Run configured lifecycle scripts.',
					} ),
			command( deps, async ( { argv, config, runtime } ) => {
				const xdebug = argv.xdebug === 'off' ? null : argv.xdebug;
				const urls = await runtime.start( config, {
					update: argv.update,
					xdebug: xdebug ?? null,
					autoPort: argv.autoPort,
				} );
				stdout.write(
					`WordPress development site started at ${ urls.siteUrl }\n`
				);
				if ( urls.testsUrl ) {
					stdout.write(
						`WordPress test site started at ${ urls.testsUrl }\n`
					);
				}
				if ( urls.phpmyadminUrl ) {
					stdout.write(
						`phpMyAdmin started at ${ urls.phpmyadminUrl }\n`
					);
				}
				if ( urls.testsPhpmyadminUrl ) {
					stdout.write(
						`phpMyAdmin for automated testing started at ${ urls.testsPhpmyadminUrl }\n`
					);
				}
				if ( argv.scripts ) {
					await runLifecycleScript( config, 'afterStart' );
				}
			} )
		)
		.command(
			'stop',
			'Stop the environment.',
			() => {},
			command( deps, async ( { config, runtime } ) => {
				await runtime.stop( config );
				stdout.write( 'Stopped.\n' );
			} )
		)
		.command(
			'reset [environment]',
			'Reset the WordPress databases and reinstall WordPress.',
			( builder ) =>
				builder
					.positional( 'environment', {
						type: 'string',
						choices: [ 'all', 'development', 'tests' ],
						default: 'development',
					} )
					.option( 'scripts', {
						type: 'boolean',
						default: true,
						describe: 'Run configured lifecycle scripts.',
					} ),
			command( deps, ( context ) =>
				resetEnvironment( stdout, context, 'afterReset' )
			)
		)
		.command(
			'clean [environment]',
			false,
			( builder ) =>
				builder
					.positional( 'environment', {
						type: 'string',
						choices: [ 'all', 'development', 'tests' ],
						default: 'development',
					} )
					.option( 'scripts', {
						type: 'boolean',
						default: true,
						describe: 'Run configured lifecycle scripts.',
					} ),
			command( deps, ( context ) => {
				stderr.write(
					'The `clean` command is deprecated. Use `reset` instead.\n'
				);
				return resetEnvironment( stdout, context, 'afterClean' );
			} )
		)
		.command(
			'cleanup',
			'Stop the environment and delete its databases, downloaded sources and state. Images are kept.',
			( builder ) =>
				builder
					.option( 'force', {
						type: 'boolean',
						alias: 'f',
						default: false,
						describe: 'Skip the confirmation prompt.',
					} )
					.option( 'scripts', {
						type: 'boolean',
						default: true,
						describe: 'Run configured lifecycle scripts.',
					} ),
			command( deps, async ( { argv, config, runtime } ) => {
				const message = `Remove the containers and ${ config.stateDirectoryPath } (databases, downloaded sources)? Images are kept.`;
				const confirmed = argv.force || ( await confirm( message ) );
				if ( ! confirmed ) {
					stderr.write(
						'Cancelled. Pass --force to skip the prompt.\n'
					);
					return 1;
				}
				await runtime.cleanup( config );
				stdout.write( 'Cleaned up.\n' );
				if ( argv.scripts ) {
					await runLifecycleScript( config, 'afterCleanup' );
				}
			} )
		)
		.command(
			'destroy',
			'Stop the environment and delete its databases, downloaded sources, state and images.',
			( builder ) =>
				builder
					.option( 'force', {
						type: 'boolean',
						alias: 'f',
						default: false,
						describe: 'Skip the confirmation prompt.',
					} )
					.option( 'scripts', {
						type: 'boolean',
						default: true,
						describe: 'Run configured lifecycle scripts.',
					} ),
			command( deps, async ( { argv, config, runtime } ) => {
				const message = `Remove the containers, the images this project uses and ${ config.stateDirectoryPath } (databases, downloaded sources)?`;
				const confirmed = argv.force || ( await confirm( message ) );
				if ( ! confirmed ) {
					stderr.write(
						'Cancelled. Pass --force to skip the prompt.\n'
					);
					return 1;
				}
				await runtime.destroy( config );
				stdout.write( 'Destroyed.\n' );
				if ( argv.scripts ) {
					await runLifecycleScript( config, 'afterDestroy' );
				}
			} )
		)
		.command(
			'run <container> [command..]',
			'Run a command in a container: cli, tests-cli, wordpress, tests-wordpress, mysql, tests-mysql or phpmyadmin.',
			( builder ) =>
				builder
					.positional( 'container', { type: 'string' } )
					.positional( 'command', {
						type: 'string',
						array: true,
						default: [],
					} )
					.option( 'env-cwd', {
						type: 'string',
						describe:
							'Working directory, relative to the WordPress root.',
					} )
					.option( 'xdebug', {
						type: 'string',
						describe:
							'Load Xdebug in cli or tests-cli. Takes a comma-separated mode list; defaults to debug.',
					} ),
			async () => {
				stderr.write( `✖ ${ RUN_USAGE }\n` );
				deps.exit( 1 );
			}
		)
		.command(
			'logs [environment]',
			'Show WordPress container logs.',
			( builder ) =>
				builder
					.positional( 'environment', {
						type: 'string',
						choices: [ 'all', 'development', 'tests' ],
						default: 'development',
					} )
					.option( 'watch', {
						type: 'boolean',
						default: true,
						describe: 'Follow the logs.',
					} ),
			command( deps, async ( { argv, config, runtime } ) => {
				await runtime.logs( config, {
					environment: argv.environment,
					watch: argv.watch,
				} );
			} )
		)
		.command(
			'status',
			'Show container state, URLs and versions.',
			( builder ) =>
				builder.option( 'json', { type: 'boolean', default: false } ),
			command( deps, async ( { argv, config, runtime } ) => {
				const status = await runtime.getStatus( config );
				if ( argv.json ) {
					stdout.write( `${ JSON.stringify( status, null, 2 ) }\n` );
					return;
				}
				const state = ( running ) =>
					running ? 'running' : 'stopped';
				stdout.write( `Project     ${ status.projectId }\n` );
				for ( const [ env, info ] of Object.entries(
					status.environments
				) ) {
					const { database } = info;
					const databasePort = database.port
						? `  port ${ database.port }`
						: '';
					stdout.write(
						`${ env.padEnd( 12 ) }${ state( info.running ) }  ${ info.url }  WordPress ${ info.wordpressVersion ?? '?' }, PHP ${ info.phpVersion }, Xdebug ${ info.xdebug }\n`
					);
					stdout.write(
						`${ ''.padEnd( 12 ) }MariaDB ${ state( database.running ) }  ${ database.image }${ databasePort }\n`
					);
					if ( info.phpmyadmin ) {
						const { phpmyadmin } = info;
						const pmaUrl = phpmyadmin.url
							? `  ${ phpmyadmin.url }`
							: '';
						stdout.write(
							`${ ''.padEnd( 12 ) }phpMyAdmin ${ state( phpmyadmin.running ) }${ pmaUrl }\n`
						);
					}
				}
			} )
		)
		.command(
			'mcp',
			'Start an MCP server (stdio) for the tests environment.',
			( builder ) =>
				builder.option( 'project', {
					type: 'string',
					describe:
						'Project directory containing .wp-env.json. Defaults to the current directory.',
				} ),
			async ( argv ) => {
				const { startServer } = require( './mcp/server' );
				try {
					if ( argv.project ) {
						process.chdir( argv.project );
					}
					await startServer( {
						customConfigPath: argv.config || null,
					} );
				} catch ( error ) {
					stderr.write( `✖ ${ error.message }\n` );
					deps.exit( 1 );
				}
			}
		)
		.demandCommand( 1, 'Pass a command.' )
		.strict()
		.fail( ( message, error ) => {
			throw error || new Error( message );
		} )
		.help()
		.alias( 'help', 'h' )
		.parseAsync();
}

module.exports = { main, parseRunArgs };
