'use strict';
const crypto = require( 'crypto' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );
const { ContainerCLI, toRecord } = require( './container-cli' );
const ports = require( './ports' );
const recipes = require( './recipes' );
const sources = require( './sources' );
const { withLock } = require( '../lock' );
const { parseJUnit } = require( '../junit' );

const DATABASE_TIMEOUT_MS = 60 * 1000;
const HTTP_TIMEOUT_MS = 60 * 1000;
const PHPUNIT_TIMEOUT_MS = 10 * 60 * 1000;
// How long a one-shot CLI container may take to reach the running state
// before `run`, `wpCli` and `phpunit` release the project lock regardless.
const LAUNCH_TIMEOUT_MS = 60 * 1000;
const LAUNCH_POLL_MS = 250;
// A one-shot CLI container lists as `stopped`, with no start date, while it
// boots. One that has not started this long after its creation counts as
// abandoned: its `container run` process ended before it started.
const COMMAND_BOOT_GRACE_MS = 10 * 60 * 1000;
const RUN_CONTAINERS = [
	'cli',
	'tests-cli',
	'wordpress',
	'tests-wordpress',
	'mysql',
	'tests-mysql',
	'phpmyadmin',
];

// Per-environment state kept between starts: the MariaDB and phpMyAdmin
// ports to reuse and the URL WordPress was last configured with.
const ENVIRONMENT_STATE_FILE = 'environments.json';

// Darwin 25 is macOS 26, the first release Apple `container` supports.
const MIN_DARWIN_MAJOR = 25;

// wp-config.php constants `wp core multisite-install` writes. It keeps them
// as they are when `MULTISITE` is already defined.
const MULTISITE_CONSTANTS = [
	'WP_ALLOW_MULTISITE',
	'MULTISITE',
	'SUBDOMAIN_INSTALL',
	'DOMAIN_CURRENT_SITE',
	'PATH_CURRENT_SITE',
	'SITE_ID_CURRENT_SITE',
	'BLOG_ID_CURRENT_SITE',
];

class EnvironmentNotRunningError extends Error {
	/**
	 * @param {'development'|'tests'|'database'|'tests-database'|'phpmyadmin'|'phpmyadmin-off'} target What is not running; `phpmyadmin-off` when `phpmyadmin` is off in the config.
	 */
	constructor( target ) {
		let message;
		switch ( target ) {
			case 'phpmyadmin':
				message =
					'phpMyAdmin is not running. Start the environment with `wp-env-container start`.';
				break;
			case 'phpmyadmin-off':
				message =
					'phpMyAdmin is not running. Set "phpmyadmin": true in .wp-env.json and start the environment with `wp-env-container start`.';
				break;
			case 'database':
				message =
					'The database is not running. Start the environment with `wp-env-container start`.';
				break;
			case 'tests-database':
				message =
					'The tests database is not running. Start the environment with `wp-env-container start`.';
				break;
			default:
				message = `The ${ target } environment is not running. Run \`wp-env-container start\` first.`;
		}
		super( message );
		this.name = 'EnvironmentNotRunningError';
	}
}

/**
 * @param {Object} record One-shot CLI container record.
 * @return {'cli'|'tests-cli'} The `run` container name of the record's environment.
 */
function cliContainerName( record ) {
	return record.labels?.[ recipes.LABEL_ENV ] === 'tests'
		? 'tests-cli'
		: 'cli';
}

class CommandRunningError extends Error {
	/**
	 * @param {Object[]} records Running one-shot CLI containers.
	 */
	constructor( records ) {
		const names = records.map( ( record ) => record.name );
		const places = records.map(
			( record ) => `${ cliContainerName( record ) } (${ record.name })`
		);
		const list = new Intl.ListFormat( 'en', { type: 'conjunction' } );
		const message =
			records.length === 1
				? `A command is still running in ${ places[ 0 ] }. Wait for it to finish or stop it with \`container stop ${ names[ 0 ] }\`.`
				: `Commands are still running in ${ list.format( places ) }. Wait for them to finish or stop them with \`container stop ${ names.join( ' ' ) }\`.`;
		super( message );
		this.name = 'CommandRunningError';
		this.containers = names;
	}
}

/**
 * @param {Object} record One-shot CLI container record.
 * @param {number} now    Current time in milliseconds since the epoch.
 * @return {boolean} Whether the command is running, stopping or still booting. A `stopped` container with a start date has exited; one without has not started yet, and counts until `COMMAND_BOOT_GRACE_MS` after its creation.
 */
function isCommandActive( record, now ) {
	if ( record.state !== 'stopped' ) {
		return true;
	}
	if ( record.startedDate ) {
		return false;
	}
	const createdAt = Date.parse( record.creationDate );
	if ( Number.isNaN( createdAt ) ) {
		return false;
	}
	return now - createdAt < COMMAND_BOOT_GRACE_MS;
}

/**
 * @param {Object[]} containers   The project's container records.
 * @param {string[]} environments Environments whose commands count.
 * @return {Object[]} The one-shot CLI containers of `environments` that run, stop or boot; see `isCommandActive`. A container that exited counts as done while it is still listed.
 */
function runningCommands( containers, environments ) {
	const now = Date.now();
	return containers.filter(
		( record ) =>
			record.labels?.[ recipes.LABEL_ROLE ] === 'cli' &&
			environments.includes( record.labels?.[ recipes.LABEL_ENV ] ) &&
			isCommandActive( record, now )
	);
}

/**
 * @param {Object[]} containers   The project's container records.
 * @param {string[]} environments Environments a recreate or reset affects.
 * @throws {CommandRunningError} When a one-shot CLI container of `environments` is running.
 */
function assertNoRunningCommands( containers, environments ) {
	const commands = runningCommands( containers, environments );
	if ( commands.length ) {
		throw new CommandRunningError( commands );
	}
}

const sleep = ( ms ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );

/**
 * Quotes `value` as one single-quoted shell word.
 *
 * @param {unknown} value Value to quote; converted with `String`.
 * @return {string} The quoted shell word.
 */
const shellQuote = ( value ) =>
	`'${ String( value ).replace( /'/g, `'\\''` ) }'`;

function md5( value ) {
	return crypto
		.createHash( 'md5' )
		.update( JSON.stringify( value ) )
		.digest( 'hex' );
}

/**
 * Hashes the settings whose change downloads the sources again, recreates
 * every database and configures WordPress again. The WordPress, MariaDB and
 * phpMyAdmin ports, the `phpmyadmin` switch and the WordPress port inside the
 * URL constants stay out: `start` compares those with the running containers
 * and the site URL each environment was configured with, and recreates or
 * reconfigures only what they affect.
 *
 * @param {Object} config Project configuration.
 * @return {string} The MD5 hash, in hex.
 */
function configHash( config ) {
	const env = Object.fromEntries(
		Object.entries( config.env ).map( ( [ name, envConfig ] ) => [
			name,
			hashedEnvironment( envConfig ),
		] )
	);
	return md5( {
		env,
		testsEnvironment: config.testsEnvironment,
		mariadbImage: config.mariadbImage,
	} );
}

/**
 * @param {Object} envConfig Configuration of one environment.
 * @return {Object} A copy without the port and phpMyAdmin settings, whose URL constants drop the WordPress port.
 */
function hashedEnvironment( envConfig ) {
	const hashed = { ...envConfig };
	for ( const key of [
		'port',
		'mysqlPort',
		'phpmyadmin',
		'phpmyadminPort',
	] ) {
		delete hashed[ key ];
	}
	if ( envConfig.config ) {
		hashed.config = recipes.withoutWordPressPort(
			envConfig.config,
			envConfig.port
		);
	}
	return hashed;
}

function enabledEnvironments( config ) {
	return config.testsEnvironment
		? [ 'development', 'tests' ]
		: [ 'development' ];
}

/**
 * @param {Object} config Project configuration.
 * @param {string} env    Environment a command targets.
 * @throws {Error} When `env` is the tests environment and it is disabled.
 */
function assertEnvironmentEnabled( config, env ) {
	if ( env === 'tests' && ! config.testsEnvironment ) {
		throw new Error(
			'The tests environment is disabled ("testsEnvironment": false in .wp-env.json).'
		);
	}
}

/**
 * @param {Object}                      config      Project configuration.
 * @param {'all'|'development'|'tests'} environment One environment, or `all` for every enabled one.
 * @return {string[]} The environments `environment` selects.
 */
function selectEnvironments( config, environment ) {
	if ( environment === 'all' ) {
		return enabledEnvironments( config );
	}
	assertEnvironmentEnabled( config, environment );
	return [ environment ];
}

/**
 * Normalizes an image reference to its fully qualified form, so `mariadb:lts`
 * and `docker.io/library/mariadb:lts` compare equal.
 *
 * @param {string} reference Image reference as written in the config.
 * @return {string} The fully qualified reference.
 */
function normalizeImageReference( reference ) {
	const parts = reference.split( '/' );
	const hasRegistry =
		parts.length > 1 &&
		( /[.:]/.test( parts[ 0 ] ) || parts[ 0 ] === 'localhost' );
	if ( ! hasRegistry ) {
		parts.unshift( parts.length === 1 ? 'docker.io/library' : 'docker.io' );
	}
	const normalized = parts.join( '/' );
	const lastSegment = normalized.split( '/' ).pop();
	const hasTag = lastSegment.includes( ':' ) || lastSegment.includes( '@' );
	return hasTag ? normalized : `${ normalized }:latest`;
}

/**
 * @param {'development'|'tests'} env Environment the database serves.
 * @return {'database'|'tests-database'} The `EnvironmentNotRunningError` target of its database.
 */
function databaseLabel( env ) {
	return env === 'tests' ? 'tests-database' : 'database';
}

/**
 * @param {Object}  config     Project configuration.
 * @param {boolean} [autoPort] Command-line choice; undefined defers to the config.
 * @return {boolean} Whether a busy WordPress port moves to a free one. Always false when `CI` is set.
 */
function isAutoPortEnabled( config, autoPort ) {
	if ( process.env.CI ) {
		return false;
	}
	return autoPort ?? Boolean( config.autoPort );
}

/**
 * @param {string} url Absolute URL.
 * @return {?string} The host of `url` with its port, or null when `url` does not parse.
 */
function urlHost( url ) {
	return URL.canParse( url ) ? new URL( url ).host : null;
}

function tail( text, lines ) {
	return text.trimEnd().split( '\n' ).slice( -lines ).join( '\n' );
}

/**
 * Runs wp-env environments on Apple's `container` runtime. The public methods
 * above the internals form the runtime interface the CLI and MCP server use.
 */
class AppleContainerRuntime {
	/**
	 * @param {Object}                    [options]
	 * @param {ContainerCLI}              [options.cli]
	 * @param {(message: string) => void} [options.log]             Progress messages; written to stderr by default.
	 * @param {number}                    [options.launchTimeoutMs] How long a one-shot command holds the project lock while its container starts.
	 */
	constructor( {
		cli = new ContainerCLI(),
		log,
		launchTimeoutMs = LAUNCH_TIMEOUT_MS,
	} = {} ) {
		this.cli = cli;
		this.launchTimeoutMs = launchTimeoutMs;
		this.log =
			log || ( ( message ) => process.stderr.write( `${ message }\n` ) );
	}

	getName() {
		return 'apple-container';
	}

	getFeatures() {
		return {
			testsEnvironment: true,
			xdebug: true,
			spx: false,
			phpMyAdmin: true,
			multisite: true,
			customPhpVersion: true,
			persistentDatabase: true,
			wpCli: true,
		};
	}

	async isAvailable() {
		try {
			await this.assertAvailable();
			return true;
		} catch {
			return false;
		}
	}

	async assertAvailable() {
		const darwinMajor = Number( os.release().split( '.' )[ 0 ] );
		if (
			process.platform !== 'darwin' ||
			process.arch !== 'arm64' ||
			darwinMajor < MIN_DARWIN_MAJOR
		) {
			throw new Error(
				'wp-env-container needs macOS 26 or later on Apple silicon.'
			);
		}
		if ( ! this.cli.isInstalled() ) {
			throw new Error(
				`Apple's container CLI was not found at ${ this.cli.binaryPath }. Install it with \`brew install container\`.`
			);
		}
		if ( ! ( await this.cli.isSystemRunning() ) ) {
			throw new Error(
				"Apple's container service is not running. Start it with `container system start`."
			);
		}
	}

	/**
	 * Starts every enabled environment. Sources, images and WordPress are
	 * (re)configured only when the hashed config (see `configHash`) changed or
	 * `update` is set. The web containers are recreated when their Xdebug
	 * modes differ from `xdebug`, and a disabled tests environment's
	 * containers are removed. WordPress is configured again when its
	 * published port no longer matches the URL it was installed with, or when
	 * its database is new. phpMyAdmin starts after its database where
	 * `phpmyadmin` is on, and is recreated when its image, database address
	 * or published port changes, and on `update`; where `phpmyadmin` is off,
	 * its container is removed. When phpMyAdmin is all that is out of date,
	 * only its containers start.
	 *
	 * @param {Object}         config             Project configuration.
	 * @param {Object}         [options]
	 * @param {boolean}        [options.update]   Download sources, update images and reconfigure WordPress.
	 * @param {?(true|string)} [options.xdebug]   Xdebug modes for the web containers; see `recipes.parseXdebugMode`. Null or `off` runs the stock image.
	 * @param {boolean}        [options.autoPort] Move a busy WordPress port to a free one; overrides `autoPort` in the config.
	 * @return {Promise<{siteUrl: string, testsUrl: ?string, phpmyadminUrl: ?string, testsPhpmyadminUrl: ?string}>} URLs of the started sites and phpMyAdmin servers; null where there is none.
	 */
	async start( config, { update = false, xdebug = null, autoPort } = {} ) {
		const environments = enabledEnvironments( config );
		const xdebugMode = this.webXdebugMode( config, environments, xdebug );
		await this.assertAvailable();
		return withLock( config.stateDirectoryPath, async () => {
			const hashPath = path.join(
				config.stateDirectoryPath,
				'config-hash'
			);
			const currentHash = configHash( config );
			const savedHash = await fs.promises
				.readFile( hashPath, 'utf8' )
				.catch( () => '' );
			const shouldConfigure = update || savedHash !== currentHash;

			await this.removeDisabledEnvironments( config );
			const containers = await this.removeDisabledPhpmyadmin(
				config,
				environments,
				await this.projectContainers( config )
			);
			const phpmyadminEnvironments = environments.filter( ( env ) =>
				recipes.isPhpmyadminEnabled( config, env )
			);
			const running = new Set(
				containers
					.filter( ( record ) => record.state === 'running' )
					.map( ( record ) => record.name )
			);
			const byName = new Map(
				containers.map( ( record ) => [ record.name, record ] )
			);
			const held = recipes.runningPorts( config.projectId, containers );
			const state = await this.readEnvironmentState( config );
			const resolved = await ports.resolvePorts( config, {
				environments,
				autoPort: isAutoPortEnabled( config, autoPort ),
				held,
				saved: state,
				isFree: ( port ) => this.isPortFree( port ),
				randomPort: () => this.pickRandomPort(),
				log: this.log,
			} );
			const started = this.withPorts( config, resolved );
			const result = {
				...this.urls( started ),
				phpmyadminUrl: this.phpmyadminUrl(
					resolved.development.phpmyadmin
				),
				testsPhpmyadminUrl: this.phpmyadminUrl(
					resolved.tests?.phpmyadmin
				),
			};

			const wordpressNames = environments.map( ( env ) =>
				recipes.wordpressContainerName( config.projectId, env )
			);
			const expected = [
				...environments.map( ( env ) =>
					recipes.databaseContainerName( config.projectId, env )
				),
				...wordpressNames,
			];
			const allRunning = expected.every( ( name ) =>
				running.has( name )
			);
			const xdebugMatches = wordpressNames.every( ( name ) => {
				const runningModes =
					byName.get( name )?.labels?.[ recipes.LABEL_XDEBUG ];
				const runningMode = runningModes
					? recipes.normalizeXdebugModes( runningModes )
					: null;
				return runningMode === xdebugMode;
			} );
			const portsMatch = environments.every(
				( env ) =>
					held[ env ].http === resolved[ env ].http &&
					held[ env ].mysql === resolved[ env ].mysql
			);
			const sitesMatch = environments.every(
				( env ) =>
					state[ env ]?.siteUrl ===
					started.env[ env ].config.WP_SITEURL
			);
			const phpmyadminDigest = phpmyadminEnvironments.length
				? await this.cli.imageDigest( recipes.PHPMYADMIN_IMAGE )
				: null;
			const phpmyadminMatches = phpmyadminEnvironments.every( ( env ) =>
				this.isPhpmyadminCurrent(
					byName.get(
						recipes.phpmyadminContainerName( config.projectId, env )
					),
					byName.get(
						recipes.databaseContainerName( config.projectId, env )
					)?.ipAddress,
					resolved[ env ].phpmyadmin,
					phpmyadminDigest
				)
			);
			const isCurrent =
				allRunning &&
				xdebugMatches &&
				portsMatch &&
				sitesMatch &&
				phpmyadminMatches;
			if ( isCurrent && ! shouldConfigure ) {
				this.log( 'Environment already running.' );
				return result;
			}
			const isPhpmyadminStale =
				allRunning &&
				xdebugMatches &&
				portsMatch &&
				sitesMatch &&
				! phpmyadminMatches &&
				! shouldConfigure;
			if ( isPhpmyadminStale ) {
				await this.ensureImage( recipes.PHPMYADMIN_IMAGE, false );
				for ( const env of phpmyadminEnvironments ) {
					const databaseName = recipes.databaseContainerName(
						config.projectId,
						env
					);
					await this.startPhpmyadmin(
						config,
						env,
						byName.get( databaseName ).ipAddress,
						{
							port: resolved[ env ].phpmyadmin,
							record: byName.get(
								recipes.phpmyadminContainerName(
									config.projectId,
									env
								)
							),
							localDigest: phpmyadminDigest,
						}
					);
					state[ env ] = {
						...state[ env ],
						phpmyadmin: resolved[ env ].phpmyadmin,
					};
				}
				await this.writeEnvironmentState( config, state );
				return result;
			}

			// A one-shot command loses its database when that database is
			// recreated, and its install when WordPress is configured again.
			const affected = environments.filter( ( env ) => {
				const databaseName = recipes.databaseContainerName(
					config.projectId,
					env
				);
				const { database } = recipes.environmentPaths( config, env );
				const isDatabaseOutdated = this.isDatabaseOutdated(
					config,
					env,
					byName.get( databaseName ),
					resolved[ env ].mysql
				);
				return (
					shouldConfigure ||
					isDatabaseOutdated ||
					! running.has( databaseName ) ||
					! fs.existsSync( database ) ||
					state[ env ]?.siteUrl !==
						started.env[ env ].config.WP_SITEURL
				);
			} );
			assertNoRunningCommands( containers, affected );

			await this.prepareImages( config, environments, {
				update,
				xdebug: Boolean( xdebugMode ),
			} );
			if ( shouldConfigure ) {
				this.log( 'Downloading sources.' );
				await sources.downloadSources( config );
				await this.prepareCore( config, environments );
			}
			await this.preparePHPUnit( config, environments, {
				force: shouldConfigure,
			} );

			// A new database folder holds no WordPress install, so its
			// environment forgets the URL it was configured with.
			const newDatabases = new Set();
			for ( const env of environments ) {
				const { database } = recipes.environmentPaths( config, env );
				state[ env ] = {
					...state[ env ],
					mysql: resolved[ env ].mysql,
				};
				if ( phpmyadminEnvironments.includes( env ) ) {
					state[ env ].phpmyadmin = resolved[ env ].phpmyadmin;
				} else {
					delete state[ env ].phpmyadmin;
				}
				if ( ! fs.existsSync( database ) ) {
					newDatabases.add( env );
					delete state[ env ].siteUrl;
				}
			}
			await this.writeEnvironmentState( config, state );

			// The web containers are recreated below. Stopping them first
			// leaves the sites stopped when a database fails to start, with
			// no web container left on a database address that changed.
			const runningWordPress = wordpressNames.filter( ( name ) =>
				running.has( name )
			);
			if ( runningWordPress.length ) {
				await this.cli.exec( [ 'stop', ...runningWordPress ] );
			}
			const dbHosts = {};
			await Promise.all(
				environments.map( async ( env ) => {
					dbHosts[ env ] = await this.startDatabase(
						config,
						env,
						running,
						{
							recreate: shouldConfigure,
							port: resolved[ env ].mysql,
						}
					);
				} )
			);
			for ( const env of phpmyadminEnvironments ) {
				await this.startPhpmyadmin( config, env, dbHosts[ env ], {
					port: resolved[ env ].phpmyadmin,
					record: byName.get(
						recipes.phpmyadminContainerName( config.projectId, env )
					),
					recreate: update,
					localDigest: phpmyadminDigest,
				} );
			}
			const clientHost = xdebugMode
				? await this.cli.hostGateway()
				: undefined;

			this.log(
				xdebugMode
					? `Starting WordPress with Xdebug (${ xdebugMode }).`
					: 'Starting WordPress.'
			);
			for ( const env of environments ) {
				const name = recipes.wordpressContainerName(
					config.projectId,
					env
				);
				await this.cli.exec( [ 'delete', '--force', name ] );
				await fs.promises.mkdir(
					recipes.environmentPaths( config, env ).reports,
					{ recursive: true }
				);
				await this.cli.run(
					recipes.runWordPressArgs( started, env, dbHosts[ env ], {
						xdebug: xdebugMode,
						clientHost,
					} )
				);
			}
			await Promise.all(
				environments.map( ( env ) =>
					this.waitForHTTP( started.env[ env ].port )
				)
			);

			const toConfigure = environments.filter(
				( env ) =>
					shouldConfigure ||
					state[ env ].siteUrl !==
						started.env[ env ].config.WP_SITEURL
			);
			if ( toConfigure.length ) {
				this.log( 'Configuring WordPress.' );
				await Promise.all(
					toConfigure.map( ( env ) =>
						this.configureWordPress( started, env, dbHosts[ env ], {
							previousUrl: state[ env ].siteUrl,
							freshInstall: newDatabases.has( env ),
						} )
					)
				);
				for ( const env of toConfigure ) {
					state[ env ].siteUrl = started.env[ env ].config.WP_SITEURL;
				}
				await this.writeEnvironmentState( config, state );
			}
			if ( shouldConfigure ) {
				await fs.promises.writeFile( hashPath, currentHash );
			}

			return result;
		} );
	}

	/**
	 * Stops the project containers, including running one-shot commands.
	 *
	 * @param {Object} config Project configuration.
	 * @return {Promise<void>} Resolves once the containers are stopped and deleted.
	 */
	async stop( config ) {
		return withLock( config.stateDirectoryPath, () =>
			this.stopContainers( config )
		);
	}

	/**
	 * Stops the project containers and deletes the state directory. Images stay.
	 *
	 * @param {Object} config
	 */
	async cleanup( config ) {
		return withLock( config.stateDirectoryPath, async () => {
			await this.stopContainers( config );
			await this.removeStateDirectory( config );
		} );
	}

	/**
	 * Stops the project containers, deletes the images this project uses
	 * unless a remaining container still references them, then deletes the
	 * state directory. A failed image deletion is logged.
	 *
	 * @param {Object} config Project configuration.
	 * @return {Promise<void>} Resolves once the project is gone.
	 */
	async destroy( config ) {
		return withLock( config.stateDirectoryPath, async () => {
			await this.stopContainers( config );
			await this.removeProjectImages( config );
			await this.removeStateDirectory( config );
		} );
	}

	/**
	 * Empties the database of `environment` and reinstalls WordPress.
	 *
	 * @param {Object}                      config
	 * @param {Object}                      [options]
	 * @param {'all'|'development'|'tests'} [options.environment]
	 */
	async clean( config, { environment = 'tests' } = {} ) {
		const environments = selectEnvironments( config, environment );
		return withLock( config.stateDirectoryPath, async () => {
			const containers = await this.projectContainers( config );
			assertNoRunningCommands( containers, environments );
			const started = this.withPorts(
				config,
				recipes.runningPorts( config.projectId, containers )
			);
			const state = await this.readEnvironmentState( config );
			for ( const env of environments ) {
				const dbHost = await this.databaseHost( config, env );
				this.log( `Resetting the ${ env } database.` );
				const reset = await this.cli.exec(
					recipes.runCLIArgs( config, env, dbHost, [
						'wp',
						'db',
						'reset',
						'--yes',
					] )
				);
				if ( reset.exitCode !== 0 ) {
					throw new Error(
						`wp db reset failed: ${ reset.stderr || reset.stdout }`
					);
				}
				await this.configureWordPress( started, env, dbHost, {
					freshInstall: true,
				} );
				state[ env ] = {
					...state[ env ],
					siteUrl: started.env[ env ].config.WP_SITEURL,
				};
				await this.writeEnvironmentState( config, state );
			}
		} );
	}

	getRunContainers() {
		return RUN_CONTAINERS;
	}

	/**
	 * Runs a command in one of the environment's containers with the caller's
	 * stdio attached. Stdin is always forwarded, so piped input reaches the
	 * command; a TTY is allocated when both stdin and stdout are terminals.
	 *
	 * @param {Object}         config
	 * @param {Object}         options
	 * @param {string}         options.container One of `getRunContainers()`.
	 * @param {string[]}       options.command
	 * @param {?string}        [options.envCwd]
	 * @param {?(true|string)} [options.xdebug]  Xdebug modes for `cli` and `tests-cli`; see `recipes.parseXdebugMode`.
	 * @return {Promise<number>} Exit code.
	 */
	async run( config, { container, command, envCwd, xdebug = null } ) {
		const tty = Boolean( process.stdin.isTTY && process.stdout.isTTY );
		let launchCommand;
		switch ( container ) {
			case 'cli':
			case 'tests-cli': {
				const env = container === 'cli' ? 'development' : 'tests';
				assertEnvironmentEnabled( config, env );
				const xdebugMode = this.cliXdebugMode( config, env, xdebug );
				launchCommand = async () => {
					const dbHost = await this.databaseHost( config, env );
					const xdebugOptions =
						await this.xdebugOptions( xdebugMode );
					return this.launchOneShot( config, env, dbHost, command, {
						cwd: envCwd,
						kind: 'run',
						interactive: true,
						tty,
						inherit: true,
						...xdebugOptions,
					} );
				};
				break;
			}
			case 'wordpress':
			case 'tests-wordpress':
			case 'mysql':
			case 'tests-mysql':
			case 'phpmyadmin': {
				if ( xdebug !== null ) {
					throw new Error(
						'Xdebug is available in cli and tests-cli only.'
					);
				}
				const { env, label, isDatabase } = this.runContainerTarget(
					config,
					container
				);
				assertEnvironmentEnabled( config, env );
				const name = this.containerNameFor( config, container );
				// The MariaDB image has no /var/www/html.
				const defaultCwd = isDatabase ? '/' : null;
				const cwd = recipes.resolveContainerCwd( envCwd || defaultCwd );
				launchCommand = async () => {
					await this.assertRunning( name, label );
					const args = [
						'exec',
						'-i',
						...( tty ? [ '-t' ] : [] ),
						'-w',
						cwd,
						name,
						...command,
					];
					return this.launch( args, null, { inherit: true } );
				};
				break;
			}
			default:
				throw new Error(
					`Unknown container "${ container }". Use one of: ${ RUN_CONTAINERS.join( ', ' ) }.`
				);
		}
		const { completion } = await withLock(
			config.stateDirectoryPath,
			launchCommand
		);
		const result = await completion;
		return result.exitCode;
	}

	/**
	 * Streams the WordPress container logs of `environment` to stdout.
	 *
	 * @param {Object}                      config
	 * @param {Object}                      [options]
	 * @param {'all'|'development'|'tests'} [options.environment]
	 * @param {boolean}                     [options.watch]
	 */
	async logs( config, { environment = 'development', watch = true } = {} ) {
		const environments = selectEnvironments( config, environment );
		await Promise.all(
			environments.map( ( env ) => {
				const name = recipes.wordpressContainerName(
					config.projectId,
					env
				);
				return this.cli.exec(
					[ 'logs', ...( watch ? [ '--follow' ] : [] ), name ],
					{ inherit: true }
				);
			} )
		);
	}

	/**
	 * Reads the state of every enabled environment. Ports and URLs come from
	 * the ports the running containers publish, falling back to the config
	 * for a stopped container.
	 *
	 * @param {Object} config Project configuration.
	 * @return {Promise<Object>} Container state, URLs, ports and versions per environment, each with its database and phpMyAdmin (null where `phpmyadmin` is off).
	 */
	async getStatus( config ) {
		const containers = await this.projectContainers( config );
		const byName = new Map(
			containers.map( ( record ) => [ record.name, record ] )
		);
		const started = this.withPorts(
			config,
			recipes.runningPorts( config.projectId, containers )
		);
		const environments = {};
		for ( const env of enabledEnvironments( config ) ) {
			const name = recipes.wordpressContainerName(
				config.projectId,
				env
			);
			const record = byName.get( name );
			const paths = recipes.environmentPaths( config, env );
			const { phpVersion } = config.env[ env ];
			const isRunning = record?.state === 'running';
			const xdebugLabel = isRunning
				? record.labels?.[ recipes.LABEL_XDEBUG ]
				: null;
			const databaseName = recipes.databaseContainerName(
				config.projectId,
				env
			);
			const database = byName.get( databaseName );
			const isDatabaseRunning = database?.state === 'running';
			environments[ env ] = {
				running: isRunning,
				container: name,
				url: this.siteUrl( started, env ),
				port: started.env[ env ].port,
				wordpressVersion: await sources.readWordPressVersion(
					paths.core
				),
				phpVersion: phpVersion || 'image default',
				image: xdebugLabel
					? recipes.xdebugWordPressImage( phpVersion )
					: recipes.wordpressImage( phpVersion ),
				xdebug: xdebugLabel || 'off',
				database: {
					running: isDatabaseRunning,
					container: databaseName,
					host: isDatabaseRunning ? database.ipAddress : null,
					port: isDatabaseRunning
						? recipes.publishedPort(
								database,
								recipes.MYSQL_CONTAINER_PORT
							)
						: null,
					image: recipes.databaseImage( config, env ),
				},
				phpmyadmin: this.phpmyadminStatus( config, env, byName ),
			};
		}
		return {
			projectId: config.projectId,
			stateDirectory: config.stateDirectoryPath,
			environments,
		};
	}

	/**
	 * @param {Object}                config Project configuration.
	 * @param {'development'|'tests'} env    Environment to read.
	 * @param {Map<string, Object>}   byName The project's container records by name.
	 * @return {?{running: boolean, container: string, url: ?string, port: ?number}} The state of the environment's phpMyAdmin, or null when `phpmyadmin` is off. The URL and port come from the running container.
	 */
	phpmyadminStatus( config, env, byName ) {
		if ( ! recipes.isPhpmyadminEnabled( config, env ) ) {
			return null;
		}
		const name = recipes.phpmyadminContainerName( config.projectId, env );
		const record = byName.get( name );
		const isRunning = record?.state === 'running';
		const port = isRunning
			? recipes.publishedPort( record, recipes.HTTP_CONTAINER_PORT )
			: null;
		return {
			running: isRunning,
			container: name,
			url: this.phpmyadminUrl( port ),
			port,
		};
	}

	/**
	 * Runs wp-cli in a one-shot CLI container and captures its output.
	 *
	 * @param {Object}                config
	 * @param {'development'|'tests'} env
	 * @param {string[]}              args                Arguments after `wp`.
	 * @param {Object}                [options]
	 * @param {string}                [options.cwd]
	 * @param {number}                [options.timeoutMs] Stops the CLI container after this long.
	 * @return {Promise<{exitCode: number, stdout: string, stderr: string, timedOut: boolean}>} Exit code and captured output.
	 */
	async wpCli( config, env, args, { cwd, timeoutMs } = {} ) {
		assertEnvironmentEnabled( config, env );
		const { completion } = await withLock(
			config.stateDirectoryPath,
			async () => {
				const dbHost = await this.databaseHost( config, env );
				await this.assertRunning(
					recipes.wordpressContainerName( config.projectId, env ),
					env
				);
				return this.launchOneShot(
					config,
					env,
					dbHost,
					[ 'wp', ...args ],
					{ cwd, timeoutMs, kind: 'wpcli' }
				);
			}
		);
		const { exitCode, stdout, stderr, timedOut } = await completion;
		return { exitCode, stdout, stderr, timedOut: Boolean( timedOut ) };
	}

	/**
	 * Runs PHPUnit for a plugin or theme in the tests environment and returns
	 * the JUnit summary alongside the tail of its output.
	 *
	 * @param {Object}         config
	 * @param {Object}         [options]
	 * @param {string}         [options.path]          Path relative to the WordPress root, e.g. `wp-content/plugins/my-plugin`.
	 * @param {string}         [options.filter]
	 * @param {string}         [options.testsuite]
	 * @param {string}         [options.configuration]
	 * @param {string[]}       [options.extraArgs]
	 * @param {number}         [options.timeoutMs]
	 * @param {number}         [options.outputLines]
	 * @param {?(true|string)} [options.xdebug]        Xdebug modes; see `recipes.parseXdebugMode`.
	 * @return {Promise<Object>} The PHPUnit run result.
	 */
	async phpunit(
		config,
		{
			path: projectPath,
			filter,
			testsuite,
			configuration,
			extraArgs = [],
			timeoutMs = PHPUNIT_TIMEOUT_MS,
			outputLines = 80,
			xdebug = null,
		} = {}
	) {
		const env = 'tests';
		assertEnvironmentEnabled( config, env );
		const xdebugMode = this.cliXdebugMode( config, env, xdebug );

		const target = projectPath || this.defaultPHPUnitPath( config );
		const hostSource = this.hostPathFor( config, target );
		const hasLocalPHPUnit =
			hostSource &&
			fs.existsSync(
				path.join( hostSource, 'vendor', 'bin', 'phpunit' )
			);
		const reportName = `junit-${ Date.now() }-${ process.pid }.xml`;
		const reportHostPath = path.join(
			recipes.environmentPaths( config, env ).reports,
			reportName
		);
		await fs.promises.mkdir( path.dirname( reportHostPath ), {
			recursive: true,
		} );

		const command = [
			hasLocalPHPUnit ? 'vendor/bin/phpunit' : 'phpunit',
			'--log-junit',
			path.posix.join( recipes.REPORTS_CONTAINER_PATH, reportName ),
		];
		if ( configuration ) {
			command.push( '--configuration', configuration );
		}
		if ( testsuite ) {
			command.push( '--testsuite', testsuite );
		}
		if ( filter ) {
			command.push( '--filter', filter );
		}
		command.push( ...extraArgs );

		const { completion } = await withLock(
			config.stateDirectoryPath,
			async () => {
				const dbHost = await this.databaseHost( config, env );
				await this.assertRunning(
					recipes.wordpressContainerName( config.projectId, env ),
					env
				);
				const xdebugOptions = await this.xdebugOptions( xdebugMode );
				return this.launchOneShot( config, env, dbHost, command, {
					cwd: target,
					timeoutMs,
					kind: 'phpunit',
					...xdebugOptions,
				} );
			}
		);
		const result = await completion;

		const xml = await fs.promises
			.readFile( reportHostPath, 'utf8' )
			.catch( () => null );
		await fs.promises.rm( reportHostPath, { force: true } );
		const summary = xml ? parseJUnit( xml ) : null;
		const output = [ result.stdout, result.stderr ]
			.filter( Boolean )
			.join( '\n' );

		return {
			passed: result.exitCode === 0 && ! result.timedOut,
			exitCode: result.exitCode,
			timedOut: result.timedOut,
			path: target,
			phpunit: hasLocalPHPUnit ? 'vendor/bin/phpunit' : 'global',
			summary,
			output: tail( output, outputLines ),
		};
	}

	/**
	 * @param {Object}                config
	 * @param {'development'|'tests'} env
	 * @param {Object}                [options]
	 * @param {'apache'|'debug_log'}  [options.source]
	 * @param {number}                [options.lines]
	 * @return {Promise<string>} The log text.
	 */
	async readLogs( config, env, { source = 'apache', lines = 100 } = {} ) {
		assertEnvironmentEnabled( config, env );
		switch ( source ) {
			case 'apache': {
				const name = recipes.wordpressContainerName(
					config.projectId,
					env
				);
				await this.assertRunning( name, env );
				return this.cli.run( [ 'logs', '-n', String( lines ), name ] );
			}
			case 'debug_log': {
				const logPath = this.debugLogPath( config, env );
				const contents = await fs.promises
					.readFile( logPath, 'utf8' )
					.catch( () => null );
				if ( contents === null ) {
					return `No debug log at ${ logPath }. Is WP_DEBUG_LOG enabled for the ${ env } environment?`;
				}
				return tail( contents, lines );
			}
			default:
				throw new Error( `Unknown log source "${ source }".` );
		}
	}

	/**
	 * Stops and deletes the project containers. Running one-shot commands
	 * stop first, each with a log line. The caller holds the project lock.
	 *
	 * @param {Object} config Project configuration.
	 * @return {Promise<void>} Resolves once the containers are gone.
	 */
	async stopContainers( config ) {
		const containers = await this.projectContainers( config );
		const commands = runningCommands( containers, recipes.ENVIRONMENTS );
		const commandNames = commands.map( ( record ) => record.name );
		for ( const record of commands ) {
			this.log(
				`Stopping ${ record.name }, a command still running in ${ cliContainerName( record ) }.`
			);
		}
		if ( commandNames.length ) {
			await this.cli.exec( [ 'stop', ...commandNames ] );
		}
		const names = containers
			.filter(
				( record ) =>
					record.state === 'running' &&
					! commandNames.includes( record.name )
			)
			.map( ( record ) => record.name );
		if ( names.length ) {
			this.log( `Stopping ${ names.join( ', ' ) }.` );
			await this.cli.exec( [ 'stop', ...names ] );
		}
		const leftovers = ( await this.projectContainers( config ) ).map(
			( record ) => record.name
		);
		if ( leftovers.length ) {
			await this.cli.exec( [ 'delete', '--force', ...leftovers ] );
		}
	}

	/**
	 * Deletes the state directory, including the project lock file. The
	 * caller holds the project lock, whose release tolerates the file being gone.
	 *
	 * @param {Object} config
	 */
	async removeStateDirectory( config ) {
		await fs.promises.rm( config.stateDirectoryPath, {
			recursive: true,
			force: true,
		} );
	}

	/**
	 * @param {Object} config Project configuration with the published ports applied.
	 * @return {{siteUrl: string, testsUrl: ?string}} URLs of the enabled sites.
	 */
	urls( config ) {
		return {
			siteUrl: this.siteUrl( config, 'development' ),
			testsUrl: config.testsEnvironment
				? this.siteUrl( config, 'tests' )
				: null,
		};
	}

	/**
	 * @param {?number} port Published phpMyAdmin port.
	 * @return {?string} The phpMyAdmin URL, or null without a port.
	 */
	phpmyadminUrl( port ) {
		return port ? `http://localhost:${ port }` : null;
	}

	/**
	 * @param {Object}                config Project configuration with the published ports applied.
	 * @param {'development'|'tests'} env    Environment of the site.
	 * @return {string} The site's `WP_HOME`, or its localhost URL.
	 */
	siteUrl( config, env ) {
		const envConfig = config.env[ env ];
		return (
			envConfig.config.WP_HOME || `http://localhost:${ envConfig.port }`
		);
	}

	/**
	 * @param {Object}                                          config   Project configuration.
	 * @param {Object<string, {http?: number, mysql?: number}>} resolved Host ports by environment.
	 * @return {Object} A copy of `config` whose WordPress ports and URLs use the `http` ports of `resolved`.
	 */
	withPorts( config, resolved ) {
		let result = config;
		for ( const [ env, envPorts ] of Object.entries( resolved ) ) {
			if ( config.env[ env ] && envPorts.http ) {
				result = recipes.withWordPressPort(
					result,
					env,
					envPorts.http
				);
			}
		}
		return result;
	}

	/**
	 * @param {Object} config Project configuration.
	 * @return {Promise<Object<string, {mysql?: number, siteUrl?: string}>>} Saved state by environment; empty when none is saved.
	 */
	async readEnvironmentState( config ) {
		const contents = await fs.promises
			.readFile(
				path.join( config.stateDirectoryPath, ENVIRONMENT_STATE_FILE ),
				'utf8'
			)
			.catch( () => null );
		try {
			const state = JSON.parse( contents );
			return state && typeof state === 'object' ? state : {};
		} catch {
			return {};
		}
	}

	/**
	 * @param {Object}                                             config Project configuration.
	 * @param {Object<string, {mysql?: number, siteUrl?: string}>} state  State by environment.
	 * @return {Promise<void>} Resolves once the file is written.
	 */
	async writeEnvironmentState( config, state ) {
		await fs.promises.mkdir( config.stateDirectoryPath, {
			recursive: true,
		} );
		await fs.promises.writeFile(
			path.join( config.stateDirectoryPath, ENVIRONMENT_STATE_FILE ),
			`${ JSON.stringify( state, null, 2 ) }\n`
		);
	}

	/**
	 * @param {number} port Host port.
	 * @return {Promise<boolean>} Whether the port is free on all interfaces and on loopback.
	 */
	isPortFree( port ) {
		return ports.isPortFree( port );
	}

	/**
	 * @return {Promise<number>} A random free host port.
	 */
	pickRandomPort() {
		return ports.pickRandomPort();
	}

	/**
	 * @param {Object} config Project configuration.
	 * @return {Promise<Object[]>} Records of the project's containers, in any state.
	 */
	projectContainers( config ) {
		return this.cli.listByLabels( {
			[ recipes.LABEL_PROJECT ]: config.projectId,
		} );
	}

	/**
	 * @param {Object} config    Project configuration.
	 * @param {string} container Container name from `run`.
	 * @return {?string} Name of the long-running container `container` refers to, or null for a CLI container.
	 */
	containerNameFor( config, container ) {
		const names = recipes.containerNames( config.projectId );
		switch ( container ) {
			case 'wordpress':
				return names.wordpress;
			case 'tests-wordpress':
				return names.testsWordpress;
			case 'mysql':
				return names.mysql;
			case 'tests-mysql':
				return names.testsMysql;
			case 'phpmyadmin':
				return names.phpmyadmin;
			default:
				return null;
		}
	}

	/**
	 * @param {Object}                                                           config    Project configuration.
	 * @param {'wordpress'|'tests-wordpress'|'mysql'|'tests-mysql'|'phpmyadmin'} container Container name from `run`.
	 * @return {{env: 'development'|'tests', label: string, isDatabase: boolean}} The environment `container` belongs to, its `EnvironmentNotRunningError` target and whether it is a database.
	 */
	runContainerTarget( config, container ) {
		switch ( container ) {
			case 'tests-wordpress':
				return { env: 'tests', label: 'tests', isDatabase: false };
			case 'mysql':
				return {
					env: 'development',
					label: 'database',
					isDatabase: true,
				};
			case 'tests-mysql':
				return {
					env: 'tests',
					label: 'tests-database',
					isDatabase: true,
				};
			case 'phpmyadmin':
				return {
					env: 'development',
					label: recipes.isPhpmyadminEnabled( config, 'development' )
						? 'phpmyadmin'
						: 'phpmyadmin-off',
					isDatabase: false,
				};
			default:
				return {
					env: 'development',
					label: 'development',
					isDatabase: false,
				};
		}
	}

	/**
	 * Starts `command` in a named one-shot CLI container and resolves once
	 * the container runs. On timeout the container is stopped before the
	 * `container run` process is killed.
	 *
	 * @param {Object}                config                Project configuration.
	 * @param {'development'|'tests'} env                   Environment the command runs in.
	 * @param {string}                dbHost                IP address of the environment's database.
	 * @param {string[]}              command               Command and arguments.
	 * @param {Object}                options
	 * @param {string}                [options.cwd]         Working directory inside the container.
	 * @param {number}                [options.timeoutMs]   Stops the container after this long.
	 * @param {string}                options.kind          Part of the container name, e.g. `phpunit`.
	 * @param {boolean}               [options.interactive] Keep stdin open.
	 * @param {boolean}               [options.tty]         Allocate a TTY.
	 * @param {boolean}               [options.inherit]     Attach the command to the caller's stdio.
	 * @param {?string}               [options.xdebug]      Xdebug modes from `xdebugOptions`.
	 * @param {string}                [options.clientHost]  Host address Xdebug connects to.
	 * @return {Promise<{completion: Promise<{exitCode: number, stdout: string, stderr: string, timedOut: boolean}>}>} The command's exit code and captured output, once it ends.
	 */
	launchOneShot(
		config,
		env,
		dbHost,
		command,
		{ cwd, timeoutMs, kind, interactive, tty, inherit, xdebug, clientHost }
	) {
		const name = `${ config.projectId }-${ kind }-${ crypto.randomBytes( 3 ).toString( 'hex' ) }`;
		return this.launch(
			recipes.runCLIArgs( config, env, dbHost, command, {
				cwd,
				interactive,
				tty,
				name,
				xdebug,
				clientHost,
			} ),
			name,
			{
				inherit,
				timeoutMs,
				onTimeout: () => this.cli.exec( [ 'stop', name ] ),
			}
		);
	}

	/**
	 * Starts `container <args>` and resolves once the container `name` runs,
	 * the command ends or `launchTimeoutMs` (60 s by default) passes. The
	 * caller holds the project lock while this runs and releases it before it
	 * waits on `completion`, so `start` and `reset` see the running container.
	 *
	 * @param {string[]} args      Arguments for `container`.
	 * @param {?string}  name      Name of the container `args` creates; null for an `exec`, which resolves at once.
	 * @param {Object}   [options] Options for `ContainerCLI.exec`.
	 * @return {Promise<{completion: Promise<{exitCode: number, stdout: string, stderr: string, timedOut: boolean}>}>} The command's result, wrapped so the lock holder returns without waiting on it.
	 */
	async launch( args, name, options ) {
		const completion = this.cli.exec( args, options );
		// The caller awaits `completion` after the lock is released.
		completion.catch( () => {} );
		if ( name ) {
			await this.waitForLaunch( name, completion );
		}
		return { completion };
	}

	/**
	 * @param {string}           name       Name of a container being started.
	 * @param {Promise<unknown>} completion Settles when the command that starts it ends.
	 * @return {Promise<void>} Resolves once the container runs, the command ends or `launchTimeoutMs` passes, whichever comes first; a failed or hung `inspect` counts as not running yet.
	 */
	async waitForLaunch( name, completion ) {
		let isDone = false;
		let deadlineTimer;
		const deadline = new Promise( ( resolve ) => {
			deadlineTimer = setTimeout( resolve, this.launchTimeoutMs );
		} );
		const done = Promise.race( [
			completion.then(
				() => {},
				() => {}
			),
			deadline,
		] ).then( () => ( isDone = true ) );
		try {
			while ( ! isDone ) {
				let pollTimer;
				const pause = new Promise( ( resolve ) => {
					pollTimer = setTimeout( resolve, LAUNCH_POLL_MS );
				} );
				await Promise.race( [ done, pause ] );
				clearTimeout( pollTimer );
				if ( isDone ) {
					return;
				}
				const record = await Promise.race( [
					this.cli
						.inspect( name, { timeoutMs: this.launchTimeoutMs } )
						.catch( () => null ),
					done.then( () => null ),
				] );
				if ( record?.state === 'running' ) {
					return;
				}
			}
		} finally {
			clearTimeout( deadlineTimer );
		}
	}

	/**
	 * Validates an Xdebug request for a CLI container.
	 *
	 * @param {Object}                config Project configuration.
	 * @param {'development'|'tests'} env    Environment the command runs in.
	 * @param {?(true|string)}        xdebug Requested modes; null or undefined when Xdebug stays off.
	 * @return {?string} The mode list, or null when Xdebug stays off.
	 * @throws {Error} When the modes are invalid or the environment's PHP version cannot run Xdebug.
	 */
	cliXdebugMode( config, env, xdebug ) {
		if ( xdebug === null || xdebug === undefined ) {
			return null;
		}
		const mode = recipes.parseXdebugMode( xdebug );
		recipes.assertXdebugSupported( config.env[ env ].phpVersion, env );
		return mode;
	}

	/**
	 * Resolves the host address Xdebug connects to.
	 *
	 * @param {?string} mode Mode list from `cliXdebugMode`; null when Xdebug stays off.
	 * @return {Promise<{xdebug?: string, clientHost?: string}>} Options for `recipes.runCLIArgs`.
	 */
	async xdebugOptions( mode ) {
		if ( mode === null ) {
			return {};
		}
		return { xdebug: mode, clientHost: await this.cli.hostGateway() };
	}

	/**
	 * Validates the Xdebug request for the web containers of `environments`.
	 * Mode `off` leaves Xdebug unloaded, so the web containers run the stock
	 * image.
	 *
	 * @param {Object}         config       Project configuration.
	 * @param {string[]}       environments Environments that start.
	 * @param {?(true|string)} xdebug       Requested modes; null or undefined when Xdebug stays off.
	 * @return {?string} The mode list, or null when Xdebug stays off.
	 * @throws {Error} When the modes are invalid or an environment's PHP version cannot run Xdebug.
	 */
	webXdebugMode( config, environments, xdebug ) {
		if ( xdebug === null || xdebug === undefined ) {
			return null;
		}
		const mode = recipes.parseXdebugMode( xdebug );
		if ( mode === 'off' ) {
			return null;
		}
		for ( const env of environments ) {
			recipes.assertXdebugSupported( config.env[ env ].phpVersion, env );
		}
		return mode;
	}

	/**
	 * Stops and deletes the tests web, database and phpMyAdmin containers when
	 * `testsEnvironment` is false. Their state folders stay. The caller holds
	 * the project lock.
	 *
	 * @param {Object} config Project configuration.
	 * @return {Promise<void>} Resolves once the containers are gone.
	 * @throws {CommandRunningError} When a command still runs in `tests-cli` while there is a container to remove.
	 */
	async removeDisabledEnvironments( config ) {
		if ( config.testsEnvironment ) {
			return;
		}
		await this.removeContainers(
			[ recipes.phpmyadminContainerName( config.projectId, 'tests' ) ],
			'"testsEnvironment": false'
		);
		const names = [
			recipes.wordpressContainerName( config.projectId, 'tests' ),
			recipes.databaseContainerName( config.projectId, 'tests' ),
		];
		const records = [];
		for ( const name of names ) {
			const record = await this.cli.inspect( name );
			if ( record ) {
				records.push( [ name, record ] );
			}
		}
		if ( ! records.length ) {
			return;
		}
		assertNoRunningCommands( await this.projectContainers( config ), [
			'tests',
		] );
		for ( const [ name, record ] of records ) {
			this.log( `Removing ${ name } ("testsEnvironment": false).` );
			if ( record.state === 'running' ) {
				await this.cli.exec( [ 'stop', name ] );
			}
			await this.cli.exec( [ 'delete', '--force', name ] );
		}
	}

	/**
	 * Stops and deletes the phpMyAdmin containers of the environments that have
	 * `phpmyadmin` off. The caller holds the project lock.
	 *
	 * @param {Object}   config       Project configuration.
	 * @param {string[]} environments Environments that start.
	 * @param {Object[]} containers   The project's container records.
	 * @return {Promise<Object[]>} `containers` without the removed ones.
	 */
	async removeDisabledPhpmyadmin( config, environments, containers ) {
		const names = environments
			.filter( ( env ) => ! recipes.isPhpmyadminEnabled( config, env ) )
			.map( ( env ) =>
				recipes.phpmyadminContainerName( config.projectId, env )
			);
		const removed = await this.removeContainers(
			names,
			'"phpmyadmin": false'
		);
		return containers.filter(
			( record ) => ! removed.includes( record.name )
		);
	}

	/**
	 * Stops and deletes the named containers that exist, with a log line each.
	 *
	 * @param {string[]} names  Container names.
	 * @param {string}   reason Setting that removes them, quoted in the log line.
	 * @return {Promise<string[]>} Names of the containers that were removed.
	 */
	async removeContainers( names, reason ) {
		const removed = [];
		for ( const name of names ) {
			const record = await this.cli.inspect( name );
			if ( ! record ) {
				continue;
			}
			this.log( `Removing ${ name } (${ reason }).` );
			if ( record.state === 'running' ) {
				await this.cli.exec( [ 'stop', name ] );
			}
			await this.cli.exec( [ 'delete', '--force', name ] );
			removed.push( name );
		}
		return removed;
	}

	/**
	 * Starts the phpMyAdmin server of `env`. A running server that already
	 * uses the image, database address and port is left alone unless
	 * `recreate` is set and still runs the local image; otherwise it is
	 * recreated.
	 *
	 * @param {Object}                config                Project configuration.
	 * @param {'development'|'tests'} env                   Environment the server serves.
	 * @param {string}                dbHost                IP address of the environment's database.
	 * @param {Object}                options
	 * @param {number}                options.port          Host port for phpMyAdmin.
	 * @param {?Object}               options.record        The server's container record from before this start.
	 * @param {boolean}               [options.recreate]    Recreate a current server, so it runs a newly pulled image.
	 * @param {?string}               [options.localDigest] Digest the local phpMyAdmin tag points to, if known.
	 * @return {Promise<void>} Resolves once the container is started.
	 */
	async startPhpmyadmin(
		config,
		env,
		dbHost,
		{ port, record, recreate = false, localDigest = null }
	) {
		const isCurrent = this.isPhpmyadminCurrent(
			record,
			dbHost,
			port,
			localDigest
		);
		if ( isCurrent && ! recreate ) {
			return;
		}
		const name = recipes.phpmyadminContainerName( config.projectId, env );
		this.log( `Starting ${ name }.` );
		if ( record?.state === 'running' ) {
			await this.cli.exec( [ 'stop', name ] );
		}
		await this.cli.exec( [ 'delete', '--force', name ] );
		await this.cli.run(
			recipes.runPhpmyadminArgs( config, env, dbHost, { port } )
		);
	}

	/**
	 * @param {?Object} record        Container record of a phpMyAdmin server.
	 * @param {?string} dbHost        IP address of the database it should reach.
	 * @param {number}  port          Host port it should publish.
	 * @param {?string} [localDigest] Digest the local phpMyAdmin tag points to, if known.
	 * @return {boolean} Whether the server runs the phpMyAdmin image against `dbHost` and publishes `port` on loopback. A record without an image reference passes the image check, and an unknown running or local digest passes the digest check.
	 */
	isPhpmyadminCurrent( record, dbHost, port, localDigest = null ) {
		if ( record?.state !== 'running' || ! dbHost ) {
			return false;
		}
		if ( record.image ) {
			const runningImage = normalizeImageReference( record.image );
			const wantedImage = normalizeImageReference(
				recipes.PHPMYADMIN_IMAGE
			);
			if ( runningImage !== wantedImage ) {
				return false;
			}
		}
		if (
			record.imageDigest &&
			localDigest &&
			record.imageDigest !== localDigest
		) {
			return false;
		}
		const recordedHost = record.labels?.[ recipes.LABEL_DB_HOST ];
		const published = ( record.ports || [] ).find(
			( entry ) => entry.containerPort === recipes.HTTP_CONTAINER_PORT
		);
		return (
			recordedHost === dbHost &&
			published?.hostPort === port &&
			published?.hostAddress === recipes.DATABASE_PUBLISH_ADDRESS
		);
	}

	async assertRunning( name, label ) {
		const record = await this.cli.inspect( name );
		if ( record?.state !== 'running' ) {
			throw new EnvironmentNotRunningError( label );
		}
		return record;
	}

	/**
	 * @param {Object}                config Project configuration.
	 * @param {'development'|'tests'} env    Environment the database serves.
	 * @return {Promise<string>} IP address of the environment's running database.
	 * @throws {EnvironmentNotRunningError} When the database is not running.
	 */
	async databaseHost( config, env ) {
		const record = await this.assertRunning(
			recipes.databaseContainerName( config.projectId, env ),
			databaseLabel( env )
		);
		if ( ! record.ipAddress ) {
			throw new Error( 'The database container has no IP address.' );
		}
		return record.ipAddress;
	}

	/**
	 * Gives a tests environment that shares the development core source its
	 * own copy of that core.
	 *
	 * @param {Object}   config       Project configuration.
	 * @param {string[]} environments Environments to prepare.
	 * @return {Promise<void>} Resolves once every core folder is ready.
	 */
	async prepareCore( config, environments ) {
		const devCore = recipes.environmentPaths( config, 'development' ).core;
		const isTestsCopy =
			environments.includes( 'tests' ) &&
			recipes.hasSharedCoreSource( config );
		if ( isTestsCopy ) {
			await sources.copyCore(
				devCore,
				recipes.environmentPaths( config, 'tests' ).core
			);
		}
	}

	async ensureImage( reference, update ) {
		const exists = await this.cli.imageExists( reference );
		if ( exists && ! update ) {
			return;
		}
		this.log( `Pulling ${ reference }.` );
		await this.cli.run( [ 'image', 'pull', reference ] );
	}

	/**
	 * Pulls the database, WordPress and phpMyAdmin images and builds the local images
	 * that are missing: the CLI image per PHP version, plus the web image with
	 * Xdebug when `xdebug` is set. `update` pulls and builds every one again.
	 *
	 * @param {Object}   config           Project configuration.
	 * @param {string[]} environments     Environments that start.
	 * @param {Object}   options
	 * @param {boolean}  options.update   Pull and build again.
	 * @param {boolean}  [options.xdebug] Build the web images with Xdebug.
	 * @return {Promise<void>} Resolves once every image exists.
	 */
	async prepareImages( config, environments, { update, xdebug = false } ) {
		const pulls = new Set();
		const phpVersions = new Set();
		for ( const env of environments ) {
			pulls.add( recipes.databaseImage( config, env ) );
			pulls.add( recipes.wordpressImage( config.env[ env ].phpVersion ) );
			if ( recipes.isPhpmyadminEnabled( config, env ) ) {
				pulls.add( recipes.PHPMYADMIN_IMAGE );
			}
			phpVersions.add( config.env[ env ].phpVersion || null );
		}
		for ( const reference of pulls ) {
			await this.ensureImage( reference, update );
		}

		const kinds = xdebug ? [ 'cli', 'wordpress' ] : [ 'cli' ];
		const missing = [];
		for ( const phpVersion of phpVersions ) {
			for ( const kind of kinds ) {
				const image = recipes.localImage( kind, phpVersion );
				const exists = await this.cli.imageExists( image.tag );
				if ( ! exists || update ) {
					missing.push( image );
				}
			}
		}
		if ( ! missing.length ) {
			return;
		}

		// `container build` boots a 2 GB BuildKit VM. Unless it was already
		// running for someone else, it is stopped after the build, including
		// when SIGINT or SIGTERM interrupts it.
		const builderWasRunning = await this.isBuilderRunning();
		const stopBuilder = async () => {
			if ( ! builderWasRunning ) {
				await this.cli.exec( [ 'builder', 'stop' ] );
			}
		};
		const exitOnSignal = ( signal ) => {
			const exitCode = signal === 'SIGINT' ? 130 : 143;
			stopBuilder()
				.catch( () => {} )
				.finally( () => process.exit( exitCode ) );
		};
		process.once( 'SIGINT', exitOnSignal );
		process.once( 'SIGTERM', exitOnSignal );
		try {
			await this.buildImages( config, missing );
		} finally {
			process.off( 'SIGINT', exitOnSignal );
			process.off( 'SIGTERM', exitOnSignal );
			await stopBuilder();
		}
	}

	/**
	 * @return {Promise<boolean>} Whether the BuildKit builder container is running.
	 */
	async isBuilderRunning() {
		const result = await this.cli.exec( [
			'builder',
			'status',
			'--format',
			'json',
		] );
		if ( result.exitCode !== 0 ) {
			return false;
		}
		try {
			const [ first ] = JSON.parse( result.stdout );
			return Boolean( first ) && toRecord( first ).state === 'running';
		} catch {
			return false;
		}
	}

	/**
	 * Builds local images, then removes the images of the same kind and PHP
	 * version built from earlier recipes.
	 *
	 * @param {Object}   config Project configuration.
	 * @param {Object[]} images Images from `recipes.localImage`.
	 * @return {Promise<void>} Resolves once every image is built.
	 */
	async buildImages( config, images ) {
		for ( const image of images ) {
			const { tag } = image;
			this.log(
				`Building ${ tag } (first run per PHP version takes a few minutes).`
			);
			const buildDir = path.join(
				config.stateDirectoryPath,
				'build',
				tag.replace( /[/:]/g, '-' )
			);
			await fs.promises.mkdir( buildDir, { recursive: true } );
			await fs.promises.writeFile(
				path.join( buildDir, 'Containerfile' ),
				image.containerfile
			);
			await this.cli.run( [
				'build',
				'--progress',
				'plain',
				'-t',
				tag,
				'-f',
				path.join( buildDir, 'Containerfile' ),
				buildDir,
			] );
			await this.removeOutdatedImages( image );
		}
	}

	/**
	 * @return {Promise<Set<string>>} Normalized references of the images that
	 *         existing containers, in any state, use.
	 */
	async imagesInUse() {
		const containers = await this.cli.list();
		return new Set(
			containers
				.filter( ( record ) => record.image )
				.map( ( record ) => normalizeImageReference( record.image ) )
		);
	}

	/**
	 * Deletes the images of the enabled environments, the database, the CLI
	 * containers, phpMyAdmin (when this project uses it) and the Xdebug web
	 * containers (when built) that no remaining container, in any state,
	 * references. The local CLI and web images built from any recipe for the
	 * PHP version of either environment, a disabled tests environment
	 * included, go too. Failures are logged.
	 *
	 * @param {Object} config Project configuration.
	 * @return {Promise<void>} Resolves once every deletion is attempted.
	 */
	async removeProjectImages( config ) {
		const wanted = new Set();
		const usesPhpmyadmin = await this.usesPhpmyadmin( config );
		if ( usesPhpmyadmin ) {
			wanted.add( recipes.PHPMYADMIN_IMAGE );
		}
		for ( const env of enabledEnvironments( config ) ) {
			const { phpVersion } = config.env[ env ];
			wanted.add( recipes.databaseImage( config, env ) );
			wanted.add( recipes.wordpressImage( phpVersion ) );
			wanted.add( recipes.cliImage( phpVersion ) );
			if ( recipes.supportsXdebug( phpVersion ) ) {
				const xdebugImage = recipes.xdebugWordPressImage( phpVersion );
				const isBuilt = await this.cli.imageExists( xdebugImage );
				if ( isBuilt ) {
					wanted.add( xdebugImage );
				}
			}
		}
		for ( const reference of await this.localProjectImages( config ) ) {
			wanted.add( reference );
		}

		let inUse;
		try {
			inUse = await this.imagesInUse();
		} catch ( error ) {
			this.log(
				`Could not list containers, keeping the images: ${ error.message }`
			);
			return;
		}

		for ( const reference of wanted ) {
			const normalized = normalizeImageReference( reference );
			if ( inUse.has( normalized ) ) {
				this.log(
					`Keeping ${ reference }: another container uses it.`
				);
				continue;
			}
			try {
				const result = await this.cli.exec( [
					'image',
					'delete',
					reference,
				] );
				if ( result.exitCode !== 0 ) {
					this.log(
						`Could not remove ${ reference }: ${ ( result.stderr || result.stdout ).trim() }`
					);
				}
			} catch ( error ) {
				this.log(
					`Could not remove ${ reference }: ${ error.message }`
				);
			}
		}
	}

	/**
	 * @param {Object} config Project configuration.
	 * @return {Promise<boolean>} Whether `phpmyadmin` is on for an enabled environment, or the saved environment state records a phpMyAdmin port.
	 */
	async usesPhpmyadmin( config ) {
		const isEnabled = enabledEnvironments( config ).some( ( env ) =>
			recipes.isPhpmyadminEnabled( config, env )
		);
		if ( isEnabled ) {
			return true;
		}
		const state = await this.readEnvironmentState( config );
		return Object.values( state ).some(
			( envState ) => envState?.phpmyadmin !== undefined
		);
	}

	/**
	 * @param {Object} config Project configuration.
	 * @return {Promise<string[]>} Local CLI and web images built for the PHP version of either environment, from any recipe. Empty when the images cannot be listed.
	 */
	async localProjectImages( config ) {
		const phpVersions = new Set(
			recipes.ENVIRONMENTS.map(
				( env ) => config.env[ env ]?.phpVersion || null
			)
		);
		let images;
		try {
			images = await this.cli.listImages();
		} catch ( error ) {
			this.log( `Could not list images: ${ error.message }` );
			return [];
		}
		const kinds = [ 'cli', 'wordpress' ];
		return images.filter( ( reference ) =>
			[ ...phpVersions ].some( ( phpVersion ) =>
				kinds.some( ( kind ) =>
					recipes.isLocalImageFor( reference, kind, phpVersion )
				)
			)
		);
	}

	/**
	 * Deletes the images of `image`'s kind and PHP version built from earlier
	 * recipes. Images that existing containers use are kept. Failures are
	 * logged and leave the images in place.
	 *
	 * @param {{kind: string, phpVersion: ?string, tag: string}} image The image just built, from `recipes.localImage`.
	 * @return {Promise<void>} Resolves once the outdated images are handled.
	 */
	async removeOutdatedImages( { kind, phpVersion, tag } ) {
		try {
			const images = await this.cli.listImages();
			const inUse = await this.imagesInUse();
			const outdated = images.filter(
				( reference ) =>
					reference !== tag &&
					recipes.isLocalImageFor( reference, kind, phpVersion ) &&
					! inUse.has( normalizeImageReference( reference ) )
			);
			if ( ! outdated.length ) {
				return;
			}
			this.log( `Removing outdated ${ outdated.join( ', ' ) }.` );
			const result = await this.cli.exec( [
				'image',
				'delete',
				...outdated,
			] );
			if ( result.exitCode !== 0 ) {
				this.log(
					`Could not remove outdated images: ${ ( result.stderr || result.stdout ).trim() }`
				);
			}
		} catch ( error ) {
			this.log( `Could not remove outdated images: ${ error.message }` );
		}
	}

	async preparePHPUnit( config, environments, { force } ) {
		for ( const env of environments ) {
			const paths = recipes.environmentPaths( config, env );
			const present = fs.existsSync( paths.phpunit );
			if ( present && ! force ) {
				continue;
			}
			this.log( `Downloading the WordPress PHPUnit suite (${ env }).` );
			const version = await sources.readWordPressVersion( paths.core );
			await sources.downloadPHPUnitSuite( paths.phpunitRepo, version );
		}
	}

	/**
	 * Starts the MariaDB server of `env` and waits until it accepts
	 * connections. A running server is recreated when `recreate` is set or
	 * its image or published port no longer match; its data folder is a bind
	 * mount and survives.
	 *
	 * @param {Object}                config             Project configuration.
	 * @param {'development'|'tests'} env                Environment the database serves.
	 * @param {Set<string>}           running            Names of the project's running containers.
	 * @param {Object}                [options]
	 * @param {boolean}               [options.recreate] Restart a running server.
	 * @param {?number}               [options.port]     Host port for MariaDB.
	 * @return {Promise<string>} The database IP address.
	 */
	async startDatabase(
		config,
		env,
		running,
		{ recreate = false, port = null } = {}
	) {
		const name = recipes.databaseContainerName( config.projectId, env );
		let isRunning = running.has( name );
		if ( isRunning ) {
			const record = await this.cli.inspect( name );
			const isOutdated = this.isDatabaseOutdated(
				config,
				env,
				record,
				port
			);
			if ( recreate || isOutdated ) {
				this.log( `Recreating ${ name }.` );
				await this.cli.exec( [ 'stop', name ] );
				isRunning = false;
			}
		}
		if ( ! isRunning ) {
			this.log( `Starting ${ name }.` );
			await fs.promises.mkdir(
				recipes.environmentPaths( config, env ).database,
				{ recursive: true }
			);
			await this.cli.exec( [ 'delete', '--force', name ] );
			await this.cli.run(
				recipes.runDatabaseArgs( config, env, { port } )
			);
		}

		const deadline = Date.now() + DATABASE_TIMEOUT_MS;
		for (;;) {
			const ping = await this.cli.exec(
				recipes.databasePingArgs( config, env )
			);
			if ( ping.exitCode === 0 ) {
				break;
			}
			const now = Date.now();
			if ( now > deadline ) {
				const logs = await this.cli.exec( [
					'logs',
					'-n',
					'30',
					name,
				] );
				throw new Error(
					`${ name } did not become ready within 60 s.\n${ logs.stdout }`
				);
			}
			await sleep( 1000 );
		}

		await this.cli.run( recipes.createDatabaseArgs( config, env ) );
		return this.databaseHost( config, env );
	}

	/**
	 * @param {Object}                config Project configuration.
	 * @param {'development'|'tests'} env    Environment the database serves.
	 * @param {?Object}               record The running database container from `inspect`.
	 * @param {?number}               port   Host port the database should publish.
	 * @return {boolean} Whether its image, published port or published address differ from the wanted ones.
	 */
	isDatabaseOutdated( config, env, record, port ) {
		if ( ! record ) {
			return false;
		}
		if ( record.image ) {
			const runningImage = normalizeImageReference( record.image );
			const wantedImage = normalizeImageReference(
				recipes.databaseImage( config, env )
			);
			if ( runningImage !== wantedImage ) {
				return true;
			}
		}
		const published = ( record.ports || [] ).find(
			( entry ) => entry.containerPort === recipes.MYSQL_CONTAINER_PORT
		);
		if ( ! published ) {
			return Boolean( port );
		}
		return (
			published.hostPort !== port ||
			published.hostAddress !== recipes.DATABASE_PUBLISH_ADDRESS
		);
	}

	async waitForHTTP( port ) {
		const deadline = Date.now() + HTTP_TIMEOUT_MS;
		for (;;) {
			try {
				await fetch( `http://127.0.0.1:${ port }/`, {
					redirect: 'manual',
					signal: AbortSignal.timeout( 5000 ),
				} );
				return;
			} catch {
				const now = Date.now();
				if ( now > deadline ) {
					throw new Error(
						`WordPress did not answer on port ${ port } within 60 s.`
					);
				}
				await sleep( 1000 );
			}
		}
	}

	/**
	 * Installs WordPress, applies `config` constants, activates plugins and
	 * writes `wp-tests-config.php`. A multisite network whose host differs
	 * from the one in `previousUrl` has that host replaced in every table
	 * with the table prefix and in `DOMAIN_CURRENT_SITE` first. A fresh
	 * install removes the multisite constants of an earlier install from
	 * `wp-config.php` first, so a network takes the current host and a
	 * single site boots without them.
	 *
	 * @param {Object}                config                 Project configuration.
	 * @param {'development'|'tests'} env                    Environment to configure.
	 * @param {string}                dbHost                 Hostname of the database container.
	 * @param {Object}                [options]
	 * @param {string}                [options.previousUrl]  Site URL the installed WordPress was last configured with.
	 * @param {boolean}               [options.freshInstall] Whether the database is empty.
	 * @return {Promise<void>} Resolves once WordPress is configured.
	 */
	async configureWordPress(
		config,
		env,
		dbHost,
		{ previousUrl, freshInstall = false } = {}
	) {
		const envConfig = config.env[ env ];
		const corePath = recipes.environmentPaths( config, env ).core;
		const wpVersion = await sources.readWordPressVersion( corePath );
		const wpVersionNumber = Number.parseFloat( wpVersion );
		const isOlder = ( target ) => wpVersion && wpVersionNumber < target;

		const installMethod = envConfig.multisite
			? 'multisite-install'
			: 'install';
		const configAnchor = isOlder( 5.1 )
			? `"define('WP_DEBUG',"`
			: `"define( 'WP_DEBUG',"`;
		const commands = [
			'set -eo pipefail',
			'[ -f /var/www/html/wp-cli.yml ] || printf "apache_modules:\\n  - mod_rewrite\\n" > /var/www/html/wp-cli.yml',
		];
		const siteHost = urlHost( envConfig.config.WP_SITEURL );
		const previousHost =
			envConfig.multisite && previousUrl ? urlHost( previousUrl ) : null;
		const isNetworkMove =
			! freshInstall &&
			previousHost !== null &&
			siteHost !== null &&
			previousHost !== siteHost;
		if ( freshInstall ) {
			for ( const name of MULTISITE_CONSTANTS ) {
				commands.push(
					`{ wp config delete ${ shellQuote( name ) } 2> /dev/null || true; }`
				);
			}
			// `wp core multisite-install` writes `$base` with the constants.
			commands.push(
				'{ wp config delete base --type=variable 2> /dev/null || true; }'
			);
		}
		if ( envConfig.multisite ) {
			// `wp core multisite-install` takes the network domain from the
			// `siteurl` option, which a defined `WP_SITEURL` overrides. Both
			// URL constants are set again from the config below.
			commands.push(
				'{ wp config delete WP_SITEURL 2> /dev/null || true; }',
				'{ wp config delete WP_HOME 2> /dev/null || true; }'
			);
		}
		if ( isNetworkMove ) {
			// The network resolves its sites by host, so WordPress loads
			// through the previous URL until the tables and constant follow.
			commands.push(
				`wp search-replace ${ shellQuote( previousHost ) } ${ shellQuote( siteHost ) } --network --all-tables-with-prefix --url=${ shellQuote( previousUrl ) }`,
				`if wp config has DOMAIN_CURRENT_SITE; then wp config set DOMAIN_CURRENT_SITE ${ shellQuote( siteHost ) }; fi`
			);
		}
		commands.push(
			`wp core ${ installMethod } --url=${ shellQuote( envConfig.config.WP_SITEURL ) } --title=${ shellQuote( config.name ) } --admin_user=admin --admin_password=password --admin_email=wordpress@example.com --skip-email`,
			`wp rewrite structure '/%year%/%monthnum%/%day%/%postname%/' --hard`
		);
		if ( envConfig.multisite ) {
			commands.push(
				`printf '%s\\n' 'RewriteEngine On' 'RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]' 'RewriteBase /' 'RewriteRule ^index\\.php$ - [L]' 'RewriteRule ^([_0-9a-zA-Z-]+/)?wp-admin$ $1wp-admin/ [R=301,L]' 'RewriteCond %{REQUEST_FILENAME} -f [OR]' 'RewriteCond %{REQUEST_FILENAME} -d' 'RewriteRule ^ - [L]' 'RewriteRule ^([_0-9a-zA-Z-]+/)?(wp-(content|admin|includes).*) $2 [L]' 'RewriteRule ^([_0-9a-zA-Z-]+/)?(.*\\.php)$ $2 [L]' 'RewriteRule . index.php [L]' > /var/www/html/.htaccess`
			);
		}
		// An existing install keeps the URLs it was installed with. The
		// `WP_SITEURL` and `WP_HOME` constants override the options while
		// defined, so they are removed before the options follow the
		// published port, and set again below.
		if ( ! envConfig.multisite ) {
			const siteUrl = envConfig.config.WP_SITEURL;
			const homeUrl = envConfig.config.WP_HOME || siteUrl;
			commands.push(
				'{ wp config delete WP_SITEURL 2> /dev/null || true; }',
				'{ wp config delete WP_HOME 2> /dev/null || true; }',
				`wp option update siteurl ${ shellQuote( siteUrl ) }`,
				`wp option update home ${ shellQuote( homeUrl ) }`
			);
		}
		for ( const [ key, rawValue ] of Object.entries( envConfig.config ) ) {
			if ( rawValue === null ) {
				continue;
			}
			const isString = typeof rawValue === 'string';
			commands.push(
				`wp config set ${ shellQuote( key ) } ${ shellQuote( rawValue ) } --anchor=${ configAnchor }${ isString ? '' : ' --raw' }`
			);
		}
		for ( const source of envConfig.pluginSources ) {
			commands.push(
				`wp plugin activate ${ shellQuote( source.basename ) }`
			);
		}

		let abspathDefinition = `define( 'ABSPATH', __DIR__ . '\\/' );`;
		if ( isOlder( 5.1 ) ) {
			abspathDefinition = `define('ABSPATH', dirname(__FILE__) . '\\/');`;
		} else if ( isOlder( 5.4 ) ) {
			abspathDefinition = `define( 'ABSPATH', dirname( __FILE__ ) . '\\/' );`;
		}
		commands.push(
			`sed -e "/^require.*wp-settings.php/d" -e "s/${ abspathDefinition }/define( 'ABSPATH', '\\/var\\/www\\/html\\/' );\\n\\tdefine( 'WP_DEFAULT_THEME', 'default' );/" /var/www/html/wp-config.php > ${ recipes.PHPUNIT_CONTAINER_PATH }/wp-tests-config.php`
		);

		let lastError;
		for ( let attempt = 1; attempt <= 3; attempt++ ) {
			const result = await this.cli.exec(
				recipes.runCLIArgs( config, env, dbHost, [
					'bash',
					'-c',
					commands.join( ' && ' ),
				] )
			);
			if ( result.exitCode === 0 ) {
				return;
			}
			lastError = result.stderr || result.stdout;
			await sleep( 2000 );
		}
		throw new Error(
			`Configuring the ${ env } environment failed:\n${ lastError }`
		);
	}

	defaultPHPUnitPath( config ) {
		const { pluginSources, themeSources } = config.env.tests;
		if ( pluginSources.length ) {
			return `wp-content/plugins/${ pluginSources[ 0 ].basename }`;
		}
		if ( themeSources.length ) {
			return `wp-content/themes/${ themeSources[ 0 ].basename }`;
		}
		throw new Error(
			'No plugin or theme in .wp-env.json to run PHPUnit for. Pass a path.'
		);
	}

	/**
	 * @param {Object} config       Project configuration.
	 * @param {string} relativePath Path relative to the WordPress root.
	 * @return {?string} The host folder mounted at `relativePath` under the WordPress root.
	 */
	hostPathFor( config, relativePath ) {
		const normalized = relativePath
			.replace( /^\/var\/www\/html\/?/, '' )
			.replace( /\/$/, '' );
		const { pluginSources, themeSources, mappings } = config.env.tests;
		const candidates = [
			...pluginSources.map( ( source ) => [
				`wp-content/plugins/${ source.basename }`,
				source.path,
			] ),
			...themeSources.map( ( source ) => [
				`wp-content/themes/${ source.basename }`,
				source.path,
			] ),
			...Object.entries( mappings ).map( ( [ dir, source ] ) => [
				dir.replace( /\/$/, '' ),
				source.path,
			] ),
		];
		for ( const [ mountPoint, hostPath ] of candidates ) {
			if ( normalized === mountPoint ) {
				return hostPath;
			}
			if ( normalized.startsWith( `${ mountPoint }/` ) ) {
				return path.join(
					hostPath,
					normalized.slice( mountPoint.length + 1 )
				);
			}
		}
		return path.join(
			recipes.environmentPaths( config, 'tests' ).core,
			normalized
		);
	}

	debugLogPath( config, env ) {
		const setting = config.env[ env ].config.WP_DEBUG_LOG;
		const corePath = recipes.environmentPaths( config, env ).core;
		const isCustomPath =
			typeof setting === 'string' &&
			setting.startsWith( '/var/www/html/' );
		if ( isCustomPath ) {
			return path.join(
				corePath,
				setting.slice( '/var/www/html/'.length )
			);
		}
		return path.join( corePath, 'wp-content', 'debug.log' );
	}
}

module.exports = {
	AppleContainerRuntime,
	CommandRunningError,
	EnvironmentNotRunningError,
	configHash,
};
