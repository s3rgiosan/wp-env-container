'use strict';
const crypto = require( 'crypto' );
const os = require( 'os' );
const path = require( 'path' );
const { loadConfig, dbEnv } = require( '@wordpress/env/lib/config' );
const fs = require( 'fs' );
const { isDebugEnabled } = require( './debug' );

// Apple `container` rejects a container name longer than 63 characters.
const MAX_CONTAINER_NAME_LENGTH = 63;
// The longest suffix a project container name adds to the project id.
// One-shot names such as `-phpunit-a1b2c3` are shorter.
const LONGEST_NAME_SUFFIX = '-tests-phpmyadmin';
const MAX_PROJECT_ID_LENGTH =
	MAX_CONTAINER_NAME_LENGTH - LONGEST_NAME_SUFFIX.length;
// The short config path hash that ends a wp-env work directory name.
const WORK_DIRECTORY_HASH = /-[0-9a-f]{8}$/;

/**
 * Root folder holding one state folder per project. Overridable so tests can
 * run against a throwaway location. A leading `~` stands for the home folder.
 *
 * @return {string} Canonical absolute path; see `canonicalPath`.
 */
function getStateRoot() {
	const override = process.env.WP_ENV_CONTAINER_HOME;
	if ( override ) {
		return canonicalPath( expandHome( override ) );
	}
	return getDefaultStateRoot();
}

/**
 * @return {string} Canonical absolute path of the state root used when
 *                  `WP_ENV_CONTAINER_HOME` is not set.
 */
function getDefaultStateRoot() {
	return canonicalPath( path.join( os.homedir(), '.wp-env-container' ) );
}

/**
 * @param {string} value Path that may start with `~` or `~/`.
 * @return {string} `value` with a leading `~` replaced by the home folder.
 */
function expandHome( value ) {
	if ( value === '~' ) {
		return os.homedir();
	}
	if ( value.startsWith( '~/' ) ) {
		return path.join( os.homedir(), value.slice( 2 ) );
	}
	return value;
}

/**
 * Resolves symbolic links and letter case through the deepest folder of
 * `value` that exists, then appends the folders that do not exist yet. Two
 * spellings of one folder, such as `/tmp/x` and `/private/tmp/x`, give the
 * same result, before and after the folder is created.
 *
 * @param {string} value Path, relative to the working directory or absolute.
 * @return {string} The canonical absolute path.
 */
function canonicalPath( value ) {
	const resolved = path.resolve( value );
	const missing = [];
	let existing = resolved;
	for (;;) {
		try {
			return path.join(
				fs.realpathSync.native( existing ),
				...missing.reverse()
			);
		} catch {
			const parent = path.dirname( existing );
			if ( parent === existing ) {
				return resolved;
			}
			missing.push( path.basename( existing ) );
			existing = parent;
		}
	}
}

/**
 * Replaces the wp-env work directory prefix in every string of `value` with
 * `to`, so downloaded sources and generated files live in this tool's state
 * folder.
 *
 * @param {unknown} value Any JSON-like value.
 * @param {string}  from  Prefix to replace.
 * @param {string}  to    Replacement prefix.
 * @return {unknown} A deep copy with paths rewritten.
 */
function remapPaths( value, from, to ) {
	const valueType = typeof value;
	if ( valueType === 'string' ) {
		const isUnderFrom =
			value === from || value.startsWith( from + path.sep );
		return isUnderFrom ? to + value.slice( from.length ) : value;
	}
	if ( Array.isArray( value ) ) {
		return value.map( ( item ) => remapPaths( item, from, to ) );
	}
	if ( value && valueType === 'object' ) {
		return Object.fromEntries(
			Object.entries( value ).map( ( [ key, item ] ) => [
				key,
				remapPaths( item, from, to ),
			] )
		);
	}
	return value;
}

/**
 * Container names must match `^[a-zA-Z0-9][a-zA-Z0-9_.-]+$` and are at most
 * 63 characters long. The project id is the work directory's name with every
 * run of other characters replaced by `-` and any leading non-alphanumeric
 * characters removed. It also names the state folder. A state root other
 * than the default adds the first six hex characters of its SHA-256 hash, so
 * each state home names its own containers. A long id is shortened; see
 * `fitProjectId`.
 *
 * @param {string} workDirectoryPath Absolute path of the wp-env work directory.
 * @return {string} Container-safe project id.
 */
function toProjectId( workDirectoryPath ) {
	const baseId = path
		.basename( workDirectoryPath )
		.replace( /[^a-zA-Z0-9_.-]+/g, '-' )
		.replace( /^[^a-zA-Z0-9]+/, '' );
	const stateRoot = getStateRoot();
	const defaultStateRoot = getDefaultStateRoot();
	if ( stateRoot === defaultStateRoot ) {
		return fitProjectId( baseId, '' );
	}
	const suffix = crypto
		.createHash( 'sha256' )
		.update( stateRoot )
		.digest( 'hex' )
		.slice( 0, 6 );
	return fitProjectId( baseId, `-${ suffix }` );
}

/**
 * Shortens the descriptive part of a project id so the longest container
 * name it derives stays within 63 characters. The work directory hash at the
 * end of `baseId` and the state home `suffix` are kept whole, so shortened
 * ids stay distinct.
 *
 * @param {string} baseId Container-safe work directory name.
 * @param {string} suffix State home suffix, such as `-a1b2c3`, or empty.
 * @return {string} The project id, at most `MAX_PROJECT_ID_LENGTH` long.
 */
function fitProjectId( baseId, suffix ) {
	const id = `${ baseId }${ suffix }`;
	if ( id.length <= MAX_PROJECT_ID_LENGTH ) {
		return id;
	}
	const hash = baseId.match( WORK_DIRECTORY_HASH )?.[ 0 ] || '';
	const room = MAX_PROJECT_ID_LENGTH - hash.length - suffix.length;
	const head = baseId
		.slice( 0, baseId.length - hash.length )
		.slice( 0, room )
		.replace( /[-_.]+$/, '' );
	return `${ head }${ hash }${ suffix }`;
}

/**
 * @param {string}  configDirectoryPath Project directory.
 * @param {?string} customConfigPath    Alternate config file.
 * @return {string[]} The config file and its override file, in merge order.
 */
function configFilePaths( configDirectoryPath, customConfigPath ) {
	if ( ! customConfigPath ) {
		return [
			path.resolve( configDirectoryPath, '.wp-env.json' ),
			path.resolve( configDirectoryPath, '.wp-env.override.json' ),
		];
	}
	const resolved = path.resolve( customConfigPath );
	const extension = path.extname( resolved );
	const base = path.basename( resolved, extension );
	return [
		resolved,
		path.join(
			path.dirname( resolved ),
			`${ base }.override${ extension }`
		),
	];
}

/**
 * Reads the root `autoPort` option. The override file wins over the config
 * file. wp-env's loader has validated both files by the time this runs.
 *
 * @param {string}  configDirectoryPath Project directory.
 * @param {?string} customConfigPath    Alternate config file.
 * @return {Promise<boolean>} Whether automatic port selection is on.
 */
async function readAutoPort( configDirectoryPath, customConfigPath ) {
	let autoPort = false;
	for ( const filePath of configFilePaths(
		configDirectoryPath,
		customConfigPath
	) ) {
		const contents = await fs.promises
			.readFile( filePath, 'utf8' )
			.catch( () => null );
		const raw = contents === null ? null : JSON.parse( contents );
		if ( typeof raw?.autoPort === 'boolean' ) {
			autoPort = raw.autoPort;
		}
	}
	return autoPort;
}

/**
 * Applies `WP_ENV_TESTS_PHPMYADMIN_PORT` to the tests environment: the
 * variable turns the tests phpMyAdmin on and sets its port. `loadConfig`
 * validates the variable before this runs; an empty value or `0` leaves the
 * config alone.
 *
 * @param {Object} config wp-env config.
 * @return {Object} `config`, or a copy whose tests environment has the port and `phpmyadmin` set.
 */
function applyTestsPhpmyadminPort( config ) {
	const port = Number.parseInt(
		process.env.WP_ENV_TESTS_PHPMYADMIN_PORT ?? '',
		10
	);
	if ( ! port ) {
		return config;
	}
	return {
		...config,
		env: {
			...config.env,
			tests: {
				...config.env.tests,
				phpmyadminPort: port,
				phpmyadmin: true,
			},
		},
	};
}

/**
 * Loads `.wp-env.json` (plus overrides and WP_ENV_* variables) through
 * wp-env's own config loader and points its generated paths at this tool's
 * state folder.
 *
 * wp-env resolves relative source paths such as "." against the process
 * working directory, so callers must run from the project directory.
 *
 * @param {Object}  options
 * @param {string}  [options.configDirectoryPath] Project directory.
 * @param {?string} [options.customConfigPath]    Alternate config file.
 * @return {Promise<Object>} The wp-env config with `stateDirectoryPath`, `projectId`, `mariadbImage` and `autoPort` added.
 */
async function loadProjectConfig( {
	configDirectoryPath = process.cwd(),
	customConfigPath = null,
} = {} ) {
	const wpEnvConfig = await loadConfig(
		configDirectoryPath,
		customConfigPath
	);
	const projectId = toProjectId( wpEnvConfig.workDirectoryPath );
	const stateDirectoryPath = path.join( getStateRoot(), projectId );
	const config = remapPaths(
		applyTestsPhpmyadminPort( wpEnvConfig ),
		wpEnvConfig.workDirectoryPath,
		stateDirectoryPath
	);

	return {
		...config,
		projectId,
		stateDirectoryPath,
		mariadbImage: dbEnv.getMariaDBImage(
			config.env.development.mariadbVersion
		),
		debug: isDebugEnabled(),
		autoPort: await readAutoPort( configDirectoryPath, customConfigPath ),
	};
}

module.exports = {
	dbEnv,
	getStateRoot,
	loadProjectConfig,
	MAX_PROJECT_ID_LENGTH,
	readAutoPort,
	applyTestsPhpmyadminPort,
	remapPaths,
	toProjectId,
};
