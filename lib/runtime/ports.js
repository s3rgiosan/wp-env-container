'use strict';
/**
 * Host port selection for the published WordPress, MariaDB and phpMyAdmin
 * ports.
 */
const net = require( 'net' );

const MAX_PORT = 65535;
const RANDOM_PORT_ATTEMPTS = 20;

// A listener on 127.0.0.1 does not stop a bind on 0.0.0.0 on macOS, so a
// port is free only when both addresses accept a listener.
const CHECKED_ADDRESSES = [ '0.0.0.0', '127.0.0.1' ];

/**
 * @param {number} port Port to bind.
 * @param {string} host Address to bind.
 * @return {Promise<?number>} The bound port (the OS choice for port 0), or null when the bind fails.
 */
function tryListen( port, host ) {
	return new Promise( ( resolve ) => {
		const server = net.createServer();
		server.once( 'error', () => resolve( null ) );
		server.once( 'listening', () => {
			const bound = server.address().port;
			server.close( () => resolve( bound ) );
		} );
		server.listen( port, host );
	} );
}

/**
 * @param {number} port Host port.
 * @return {Promise<boolean>} Whether `port` accepts a listener on all interfaces and on loopback.
 */
async function isPortFree( port ) {
	for ( const host of CHECKED_ADDRESSES ) {
		const bound = await tryListen( port, host );
		if ( bound === null ) {
			return false;
		}
	}
	return true;
}

/**
 * @return {Promise<number>} A free port the OS picks from its ephemeral range.
 * @throws {Error} When no free port turns up.
 */
async function pickRandomPort() {
	for ( let attempt = 0; attempt < RANDOM_PORT_ATTEMPTS; attempt++ ) {
		const port = await tryListen( 0, '0.0.0.0' );
		if ( port === null ) {
			continue;
		}
		const isFree = await isPortFree( port );
		if ( isFree ) {
			return port;
		}
	}
	throw new Error( 'Could not find a free host port.' );
}

/**
 * Picks the host ports of every enabled environment: the WordPress port, the
 * MariaDB port and, where phpMyAdmin is on, the phpMyAdmin port. Configured ports that must be used as set (strict) are
 * reserved first, so a saved, random or automatic port never takes one.
 *
 * - WordPress uses its configured port. With `autoPort`, a busy port moves to
 *   the next free port above it; without it, a busy port is an error. A
 *   running site keeps its port while that matches the configured port, or,
 *   with `autoPort`, while the configured port is busy.
 * - MariaDB uses `mysqlPort` when set, and a busy one is an error. Without
 *   it, MariaDB reuses the port saved from its last start when that port is
 *   still free, and otherwise gets a random free port. A running database
 *   without `mysqlPort` keeps its port. When both environments have the same
 *   `mysqlPort`, it belongs to the development database and the tests
 *   database is handled as if it had none.
 * - phpMyAdmin follows the MariaDB rules with `phpmyadminPort`, and keeps its
 *   saved port the same way. When both environments have the same
 *   `phpmyadminPort`, it belongs to the development phpMyAdmin and the tests
 *   phpMyAdmin is handled as if it had none.
 *
 * @param {Object}                                                               config               Project configuration.
 * @param {Object}                                                               options
 * @param {string[]}                                                             options.environments Environments that start.
 * @param {boolean}                                                              options.autoPort     Move a busy WordPress port.
 * @param {Object<string, {http?: number, mysql?: number, phpmyadmin?: number}>} options.held         Ports the project's running containers publish, by environment.
 * @param {Object<string, {mysql?: number, phpmyadmin?: number}>}                options.saved        MariaDB and phpMyAdmin ports from the last start, by environment.
 * @param {(port: number) => Promise<boolean>}                                   [options.isFree]     Port check.
 * @param {() => Promise<number>}                                                [options.randomPort] Random free port.
 * @param {(message: string) => void}                                            [options.log]        Progress messages.
 * @return {Promise<Object<string, {http: number, mysql: number, phpmyadmin?: number}>>} Ports by environment; `phpmyadmin` only where phpMyAdmin is on.
 * @throws {Error} When a required port is busy or no free port turns up.
 */
async function resolvePorts(
	config,
	{
		environments,
		autoPort,
		held,
		saved,
		isFree = isPortFree,
		randomPort = pickRandomPort,
		log = () => {},
	}
) {
	const httpHint = process.env.CI
		? 'or set "port"/"testsPort" in .wp-env.json or WP_ENV_PORT/WP_ENV_TESTS_PORT (automatic port selection is off while CI is set)'
		: 'set "port"/"testsPort" in .wp-env.json or WP_ENV_PORT/WP_ENV_TESTS_PORT, or enable automatic port selection with --auto-port or "autoPort": true';
	const requests = [];
	for ( const env of environments ) {
		requests.push( {
			env,
			role: 'http',
			label: env,
			configured: config.env[ env ].port,
			mode: autoPort ? 'auto' : 'strict',
			hint: httpHint,
		} );
	}
	for ( const env of environments ) {
		requests.push( databaseRequest( config, env, saved ) );
	}
	for ( const env of environments ) {
		if ( config.env[ env ].phpmyadmin ) {
			requests.push( phpmyadminRequest( config, env, saved ) );
		}
	}

	const taken = new Set();
	for ( const env of environments ) {
		for ( const port of Object.values( held[ env ] || {} ) ) {
			taken.add( port );
		}
	}
	const reserved = requests
		.filter( ( request ) => request.mode === 'strict' )
		.map( ( request ) => request.configured );
	const resolved = Object.fromEntries(
		environments.map( ( env ) => [ env, {} ] )
	);

	for ( const { env, role, sharedNotice, ...request } of requests ) {
		const current = held[ env ]?.[ role ];
		const unavailable = new Set( taken );
		unavailable.delete( current );
		if ( request.mode !== 'strict' ) {
			for ( const port of reserved ) {
				unavailable.add( port );
			}
		}
		const port = await choosePort( {
			...request,
			current,
			taken: unavailable,
			isFree,
			randomPort,
		} );
		taken.add( port );
		resolved[ env ][ role ] = port;
		if ( sharedNotice ) {
			log( sharedNotice( port ) );
		}
	}
	return resolved;
}

/**
 * @param {Object}                           config Project configuration.
 * @param {'development'|'tests'}            env    Environment the database serves.
 * @param {Object<string, {mysql?: number}>} saved  MariaDB ports from the last start, by environment.
 * @return {Object} The port request of the environment's database; `sharedNotice` words the log line when the tests database leaves the development `mysqlPort` to the development one.
 */
function databaseRequest( config, env, saved ) {
	const configured = config.env[ env ].mysqlPort || null;
	const developmentPort = config.env.development?.mysqlPort || null;
	const isShared =
		env === 'tests' &&
		configured !== null &&
		configured === developmentPort;
	const isStrict = configured !== null && ! isShared;
	return {
		env,
		role: 'mysql',
		label: env === 'tests' ? 'tests database' : 'database',
		configured: isStrict ? configured : saved[ env ]?.mysql || null,
		mode: isStrict ? 'strict' : 'random',
		hint: 'set another "mysqlPort" in .wp-env.json or WP_ENV_MYSQL_PORT/WP_ENV_TESTS_MYSQL_PORT, or leave it empty for a random port',
		sharedNotice: isShared
			? ( port ) =>
					`Tests database uses port ${ port }; "mysqlPort" ${ configured } belongs to the development database.`
			: null,
	};
}

/**
 * @param {Object}                                config Project configuration.
 * @param {'development'|'tests'}                 env    Environment phpMyAdmin serves.
 * @param {Object<string, {phpmyadmin?: number}>} saved  phpMyAdmin ports from the last start, by environment.
 * @return {Object} The port request of the environment's phpMyAdmin; `sharedNotice` words the log line when the tests phpMyAdmin leaves the development `phpmyadminPort` to the development one.
 */
function phpmyadminRequest( config, env, saved ) {
	const configured = config.env[ env ].phpmyadminPort || null;
	const development = config.env.development;
	const developmentPort =
		development?.phpmyadmin && development.phpmyadminPort
			? development.phpmyadminPort
			: null;
	const isShared =
		env === 'tests' &&
		configured !== null &&
		configured === developmentPort;
	const isStrict = configured !== null && ! isShared;
	return {
		env,
		role: 'phpmyadmin',
		label: env === 'tests' ? 'tests phpMyAdmin' : 'phpMyAdmin',
		configured: isStrict ? configured : saved[ env ]?.phpmyadmin || null,
		mode: isStrict ? 'strict' : 'random',
		hint: 'set another "phpmyadminPort" in .wp-env.json or WP_ENV_PHPMYADMIN_PORT/WP_ENV_TESTS_PHPMYADMIN_PORT, or leave it empty for a random port',
		sharedNotice: isShared
			? ( port ) =>
					`Tests phpMyAdmin uses port ${ port }; "phpmyadminPort" ${ configured } belongs to the development phpMyAdmin.`
			: null,
	};
}

/**
 * @param {Object}                             request
 * @param {string}                             request.label      What the port is for, in error messages.
 * @param {?number}                            request.configured Wanted port; for `random`, the port to try first.
 * @param {'strict'|'auto'|'random'}           request.mode       How a busy port is handled.
 * @param {string}                             [request.hint]     How to fix a busy strict port, in error messages.
 * @param {number}                             [request.current]  Port the role's running container publishes.
 * @param {Set<number>}                        request.taken      Ports other roles use or reserve.
 * @param {(port: number) => Promise<boolean>} request.isFree     Port check.
 * @param {() => Promise<number>}              request.randomPort Random free port.
 * @return {Promise<number>} The chosen port.
 * @throws {Error} When a strict port is busy or no free port turns up.
 */
async function choosePort( {
	label,
	configured,
	mode,
	hint,
	current,
	taken,
	isFree,
	randomPort,
} ) {
	const keepsCurrent = await keepsCurrentPort( {
		configured,
		mode,
		current,
		taken,
		isFree,
	} );
	if ( keepsCurrent ) {
		return current;
	}
	switch ( mode ) {
		case 'strict': {
			const isAvailable =
				! taken.has( configured ) && ( await isFree( configured ) );
			if ( ! isAvailable ) {
				throw new Error(
					`Port ${ configured } (${ label }) is already in use. Free it, ${ hint }.`
				);
			}
			return configured;
		}
		case 'auto': {
			for ( let port = configured; port <= MAX_PORT; port++ ) {
				if ( taken.has( port ) ) {
					continue;
				}
				const isAvailable = await isFree( port );
				if ( isAvailable ) {
					return port;
				}
			}
			throw new Error(
				`Could not find a free port for ${ label } from ${ configured } up.`
			);
		}
		default: {
			const reusesSaved =
				configured &&
				! taken.has( configured ) &&
				( await isFree( configured ) );
			if ( reusesSaved ) {
				return configured;
			}
			for ( let attempt = 0; attempt < RANDOM_PORT_ATTEMPTS; attempt++ ) {
				const port = await randomPort();
				if ( ! taken.has( port ) ) {
					return port;
				}
			}
			throw new Error( `Could not find a free port for ${ label }.` );
		}
	}
}

/**
 * @param {Object}                             request
 * @param {?number}                            request.configured Wanted port.
 * @param {'strict'|'auto'|'random'}           request.mode       How a busy port is handled.
 * @param {number}                             [request.current]  Port the role's running container publishes.
 * @param {Set<number>}                        request.taken      Ports other roles use or reserve.
 * @param {(port: number) => Promise<boolean>} request.isFree     Port check.
 * @return {Promise<boolean>} Whether the role stays on `current`: a strict role when it is the configured port, an automatic one also while the configured port is busy, a random one always.
 */
async function keepsCurrentPort( {
	configured,
	mode,
	current,
	taken,
	isFree,
} ) {
	if ( current === undefined ) {
		return false;
	}
	switch ( mode ) {
		case 'strict':
			return current === configured;
		case 'auto': {
			if ( current === configured ) {
				return true;
			}
			const isConfiguredFree =
				! taken.has( configured ) && ( await isFree( configured ) );
			return ! isConfiguredFree;
		}
		default:
			return true;
	}
}

module.exports = {
	isPortFree,
	pickRandomPort,
	resolvePorts,
};
