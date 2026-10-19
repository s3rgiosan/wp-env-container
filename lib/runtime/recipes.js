'use strict';
/**
 * Pure builders for `container` argument arrays and the names, labels,
 * mounts and environment variables they use. Nothing here runs a process.
 */
const crypto = require( 'crypto' );
const path = require( 'path' );
const { dbEnv } = require( '../config' );

const LABEL_PROJECT = 'dev.wp-env-container.project';
const LABEL_ENV = 'dev.wp-env-container.env';
const LABEL_ROLE = 'dev.wp-env-container.role';
const LABEL_XDEBUG = 'dev.wp-env-container.xdebug';
const LABEL_DB_HOST = 'dev.wp-env-container.db-host';

const ENVIRONMENTS = [ 'development', 'tests' ];

const PHPUNIT_CONTAINER_PATH = '/wordpress-phpunit';
// Host address of the published WordPress ports: all interfaces.
const PUBLISH_ADDRESS = '0.0.0.0';
// Host address of the published MariaDB and phpMyAdmin ports: loopback, so
// only the Mac itself reaches the databases and the root login phpMyAdmin
// holds.
const DATABASE_PUBLISH_ADDRESS = '127.0.0.1';
const PHPMYADMIN_IMAGE = 'phpmyadmin';
const HTTP_CONTAINER_PORT = 80;
const MYSQL_CONTAINER_PORT = 3306;
// wp-config constants whose URL carries the WordPress port.
const URL_CONSTANTS = [ 'WP_TESTS_DOMAIN', 'WP_SITEURL', 'WP_HOME' ];
// A domain or URL split into its scheme and host, its port and the rest.
const URL_PATTERN = /^((?:.+:\/\/)?[a-z0-9.\-]+)(?::([0-9]+))?(.*)$/i;
const REPORTS_CONTAINER_PATH = '/wp-env-container-reports';

// Images this tool builds locally, by kind: `cli` for the one-shot CLI
// containers, `wordpress` for the web containers with Xdebug.
const LOCAL_IMAGES = {
	cli: {
		repository: 'wp-env-container/cli',
		containerfile: cliContainerfile,
	},
	wordpress: {
		repository: 'wp-env-container/wordpress',
		containerfile: xdebugWordPressContainerfile,
	},
};

// Xdebug is installed in the CLI image but loads only when PHP also scans
// this folder.
const XDEBUG_CONF_DIR = '/usr/local/etc/php/conf.d-xdebug';
const XDEBUG_CLIENT_PORT = 9003;
const XDEBUG_SERVER_NAME = 'wp-env-container';
// Variables the web image's Xdebug ini file reads through `${VAR}`.
const WEB_XDEBUG_MODE_VARIABLE = 'WP_ENV_CONTAINER_XDEBUG_MODE';
const WEB_XDEBUG_HOST_VARIABLE = 'WP_ENV_CONTAINER_XDEBUG_CLIENT_HOST';
const XDEBUG_MODES = [
	'off',
	'develop',
	'coverage',
	'debug',
	'gcstats',
	'profile',
	'trace',
];

// Apple `container` gives a container no name-based DNS for its siblings, so
// the database is always reached by IP.
const DB_ROOT_PASSWORD = dbEnv.credentials.WORDPRESS_DB_PASSWORD;

/**
 * @param {string} projectId Id of the project.
 * @return {{mysql: string, testsMysql: string, wordpress: string, testsWordpress: string, phpmyadmin: string, testsPhpmyadmin: string}} Container names by role.
 */
function containerNames( projectId ) {
	return {
		phpmyadmin: `${ projectId }-phpmyadmin`,
		testsPhpmyadmin: `${ projectId }-tests-phpmyadmin`,
		mysql: `${ projectId }-mysql`,
		testsMysql: `${ projectId }-tests-mysql`,
		wordpress: `${ projectId }-wordpress`,
		testsWordpress: `${ projectId }-tests-wordpress`,
	};
}

/**
 * @param {string}                projectId Id of the project.
 * @param {'development'|'tests'} env       Environment the database serves.
 * @return {string} Name of the MariaDB container for `env`.
 */
function databaseContainerName( projectId, env ) {
	const names = containerNames( projectId );
	return env === 'tests' ? names.testsMysql : names.mysql;
}

/**
 * @param {string}                projectId Id of the project.
 * @param {'development'|'tests'} env       Environment phpMyAdmin serves.
 * @return {string} Name of the phpMyAdmin container for `env`.
 */
function phpmyadminContainerName( projectId, env ) {
	const names = containerNames( projectId );
	return env === 'tests' ? names.testsPhpmyadmin : names.phpmyadmin;
}

/**
 * @param {Object}                config Project configuration.
 * @param {'development'|'tests'} env    Environment to check.
 * @return {boolean} Whether `env` has phpMyAdmin turned on.
 */
function isPhpmyadminEnabled( config, env ) {
	return Boolean( config.env[ env ]?.phpmyadmin );
}

/**
 * @param {Object}                config Project configuration.
 * @param {'development'|'tests'} env    Environment the database serves.
 * @return {string} The MariaDB image from the environment's `mariadbVersion`.
 */
function databaseImage( config, env ) {
	return dbEnv.getMariaDBImage( config.env[ env ].mariadbVersion );
}

/**
 * @param {string}                projectId
 * @param {'development'|'tests'} env
 * @return {string} Name of the long-running WordPress container for `env`.
 */
function wordpressContainerName( projectId, env ) {
	const names = containerNames( projectId );
	return env === 'tests' ? names.testsWordpress : names.wordpress;
}

function labelArgs( labels ) {
	return Object.entries( labels ).flatMap( ( [ key, value ] ) => [
		'--label',
		`${ key }=${ value }`,
	] );
}

function projectLabels( projectId, role, env ) {
	const labels = { [ LABEL_PROJECT ]: projectId, [ LABEL_ROLE ]: role };
	if ( env ) {
		labels[ LABEL_ENV ] = env;
	}
	return labels;
}

/**
 * @param {?string} phpVersion e.g. "8.3".
 * @return {string} The stock WordPress Apache image for that PHP version.
 */
function wordpressImage( phpVersion ) {
	return phpVersion ? `wordpress:php${ phpVersion }` : 'wordpress:latest';
}

/**
 * @param {?string} phpVersion e.g. "8.3", or null for the image default.
 * @param {string}  minimum    e.g. "7.2".
 * @return {boolean} Whether `phpVersion` is `minimum` or later. The image
 *         default counts as the latest PHP.
 */
function isPHPVersionAtLeast( phpVersion, minimum ) {
	if ( ! phpVersion ) {
		return true;
	}
	const versionParts = String( phpVersion ).split( '.' ).map( Number );
	const minimumParts = minimum.split( '.' ).map( Number );
	if ( versionParts[ 0 ] !== minimumParts[ 0 ] ) {
		return versionParts[ 0 ] > minimumParts[ 0 ];
	}
	const minor = versionParts[ 1 ] ?? 0;
	return minor >= minimumParts[ 1 ];
}

/**
 * @param {?string} phpVersion
 * @return {boolean} Whether Xdebug 3 runs on that PHP version.
 */
function supportsXdebug( phpVersion ) {
	return isPHPVersionAtLeast( phpVersion, '7.2' );
}

/**
 * PECL packages the CLI image installs for a PHP version.
 *
 * @param {?string} phpVersion
 * @return {{pcov: ?string, xdebug: ?string}} Package names, null for an
 *         extension that does not support that PHP version.
 */
function phpExtensionPackages( phpVersion ) {
	if ( ! isPHPVersionAtLeast( phpVersion, '7.1' ) ) {
		return { pcov: null, xdebug: null };
	}
	if ( ! supportsXdebug( phpVersion ) ) {
		return { pcov: 'pcov', xdebug: null };
	}
	const isPHP7 = ! isPHPVersionAtLeast( phpVersion, '8.0' );
	return { pcov: 'pcov', xdebug: isPHP7 ? 'xdebug-3.1.6' : 'xdebug' };
}

/**
 * @param {?string} phpVersion
 * @return {string} The part of a local image tag that names the PHP version.
 */
function imageTagPrefix( phpVersion ) {
	return phpVersion ? `php${ phpVersion }` : 'latest';
}

/**
 * A locally built image. Its tag ends in a hash of the Containerfile, so a
 * changed recipe gets a new image.
 *
 * @param {'cli'|'wordpress'} kind       Image kind, a key of `LOCAL_IMAGES`.
 * @param {?string}           phpVersion PHP version, or null for the image default.
 * @return {{kind: string, phpVersion: ?string, containerfile: string, tag: string}} The image recipe and tag.
 */
function localImage( kind, phpVersion ) {
	const { repository, containerfile } = LOCAL_IMAGES[ kind ];
	const text = containerfile( phpVersion );
	const hash = crypto
		.createHash( 'sha256' )
		.update( text )
		.digest( 'hex' )
		.slice( 0, 8 );
	return {
		kind,
		phpVersion,
		containerfile: text,
		tag: `${ repository }:${ imageTagPrefix( phpVersion ) }-${ hash }`,
	};
}

/**
 * @param {?string} phpVersion
 * @return {string} The locally built CLI image tag.
 */
function cliImage( phpVersion ) {
	return localImage( 'cli', phpVersion ).tag;
}

/**
 * @param {?string} phpVersion
 * @return {string} The locally built web image tag with Xdebug installed.
 */
function xdebugWordPressImage( phpVersion ) {
	return localImage( 'wordpress', phpVersion ).tag;
}

/**
 * @param {string}            reference  An image name from `container image list`.
 * @param {'cli'|'wordpress'} kind       Image kind, a key of `LOCAL_IMAGES`.
 * @param {?string}           phpVersion PHP version, or null for the image default.
 * @return {boolean} Whether `reference` is a local image of `kind` built for
 *         `phpVersion` from any recipe, the current one included.
 */
function isLocalImageFor( reference, kind, phpVersion ) {
	const prefix = `${ LOCAL_IMAGES[ kind ].repository }:${ imageTagPrefix( phpVersion ) }`;
	if ( reference === prefix ) {
		return true;
	}
	const suffix = reference.slice( prefix.length + 1 );
	return (
		reference.startsWith( `${ prefix }-` ) && /^[0-9a-f]{8}$/.test( suffix )
	);
}

/**
 * The step that installs PCOV and Xdebug. PCOV is enabled; Xdebug gets an ini
 * file in `XDEBUG_CONF_DIR` that loads it and turns PCOV off.
 *
 * @param {?string} phpVersion
 * @return {string} A `RUN` instruction, or an empty string when neither
 *         extension supports that PHP version.
 */
function extensionsStep( phpVersion ) {
	const packages = phpExtensionPackages( phpVersion );
	if ( ! packages.pcov ) {
		return '';
	}
	const peclPackages = [ packages.pcov, packages.xdebug ]
		.filter( Boolean )
		.join( ' ' );
	const steps = [
		'apk add --no-cache --virtual .build-deps $PHPIZE_DEPS linux-headers',
		`pecl install ${ peclPackages }`,
		'docker-php-ext-enable pcov',
	];
	if ( packages.xdebug ) {
		const ini = [
			'zend_extension=xdebug',
			'pcov.enabled=0',
			'xdebug.start_with_request=yes',
			'xdebug.log_level=0',
		];
		steps.push(
			`mkdir -p ${ XDEBUG_CONF_DIR }`,
			`printf '%s\\n' ${ ini.map( ( line ) => `'${ line }'` ).join( ' ' ) } > ${ XDEBUG_CONF_DIR }/xdebug.ini`
		);
	}
	steps.push( 'apk del .build-deps', 'rm -rf /tmp/pear' );
	return `RUN ${ steps.join( ' \\\n && ' ) }\n`;
}

// Prefixes `wp` when the first argument is an option or a wp-cli subcommand.
// The subcommand probe runs with Xdebug off and without loading a WordPress
// site, so a debugging session opens for the requested command only.
const ENTRYPOINT_STEP = `RUN printf '%s\\n' \\
  '#!/bin/sh' \\
  'set -euo pipefail' \\
  'if [ "\${1#-}" != "$1" ] || XDEBUG_MODE=off wp --path=/dev/null help "$1" > /dev/null 2>&1; then' \\
  '	set -- wp "$@"' \\
  'fi' \\
  'exec "$@"' \\
  > /usr/local/bin/wp-env-container-entrypoint \\
 && chmod 755 /usr/local/bin/wp-env-container-entrypoint
ENTRYPOINT ["wp-env-container-entrypoint"]
`;

/**
 * Containerfile for the CLI image: wp-cli plus Composer, a global PHPUnit,
 * PCOV for coverage and an opt-in Xdebug, so `phpunit` works in
 * `cli`/`tests-cli` without a project dependency.
 *
 * @param {?string} phpVersion PHP version of the image, or null for the image default.
 * @return {string} The Containerfile text.
 */
function cliContainerfile( phpVersion ) {
	const base = `wordpress:cli${ phpVersion ? `-php${ phpVersion }` : '' }`;
	return `FROM ${ base }
USER root
ENV COMPOSER_HOME=/usr/local/share/composer
ENV COMPOSER_ALLOW_SUPERUSER=1
ENV PATH="\${PATH}:/usr/local/share/composer/vendor/bin"
RUN php -r "copy('https://getcomposer.org/installer', '/tmp/composer-setup.php');" \\
 && EXPECTED="$(php -r "echo trim(file_get_contents('https://composer.github.io/installer.sig'));")" \\
 && ACTUAL="$(php -r "echo hash_file('sha384', '/tmp/composer-setup.php');")" \\
 && [ "$EXPECTED" = "$ACTUAL" ] \\
 && php /tmp/composer-setup.php --install-dir=/usr/local/bin --filename=composer \\
 && rm /tmp/composer-setup.php
RUN composer global require --dev phpunit/phpunit:"^5.7.21 || ^6.0 || ^7.0 || ^8.0 || ^9.0 || ^10.0" \\
 && chmod -R a+rX "$COMPOSER_HOME"
${ extensionsStep( phpVersion ) }${ ENTRYPOINT_STEP }USER www-data
`;
}

/**
 * Containerfile for the web image with Xdebug: the stock WordPress image plus
 * the Xdebug release the CLI image installs for that PHP version. Its ini
 * file reads the mode and client host from environment variables, so one
 * image serves every mode list, and Apache passes `PHP_IDE_CONFIG` on to
 * `$_SERVER`, where IDEs read the server name.
 *
 * @param {?string} phpVersion PHP version of the image, or null for the image default.
 * @return {string} The Containerfile text.
 * @throws {Error} When Xdebug does not run on that PHP version.
 */
function xdebugWordPressContainerfile( phpVersion ) {
	assertXdebugSupported( phpVersion );
	const { xdebug } = phpExtensionPackages( phpVersion );
	const ini = [
		`xdebug.mode=\${${ WEB_XDEBUG_MODE_VARIABLE }}`,
		`xdebug.client_host=\${${ WEB_XDEBUG_HOST_VARIABLE }}`,
		`xdebug.client_port=${ XDEBUG_CLIENT_PORT }`,
		'xdebug.start_with_request=yes',
		'xdebug.log_level=0',
	];
	return `FROM ${ wordpressImage( phpVersion ) }
RUN pecl install ${ xdebug } \\
 && docker-php-ext-enable xdebug \\
 && rm -rf /tmp/pear \\
 && printf '%s\\n' ${ ini.map( ( line ) => `'${ line }'` ).join( ' ' ) } > /usr/local/etc/php/conf.d/wp-env-container-xdebug.ini \\
 && printf '%s\\n' 'PassEnv PHP_IDE_CONFIG' > /etc/apache2/conf-enabled/wp-env-container-xdebug.conf
`;
}

/**
 * @param {string} modes Comma-separated Xdebug modes.
 * @return {string} The same modes sorted, each listed once.
 */
function normalizeXdebugModes( modes ) {
	return [ ...new Set( modes.split( ',' ) ) ].sort().join( ',' );
}

/**
 * Validates an Xdebug mode list.
 *
 * @param {true|string} value `true` or an empty string for step debugging,
 *                            otherwise a comma-separated list of modes.
 * @return {string} The mode list for `XDEBUG_MODE`, sorted and without repeats.
 * @throws {Error} When `value` is not a list of known modes.
 */
function parseXdebugMode( value ) {
	if ( value === true || value === '' ) {
		return 'debug';
	}
	const isModeList =
		typeof value === 'string' &&
		value.split( ',' ).every( ( mode ) => XDEBUG_MODES.includes( mode ) );
	if ( ! isModeList ) {
		throw new Error(
			`Invalid Xdebug mode "${ value }". Use a comma-separated list of: ${ XDEBUG_MODES.join( ', ' ) }.`
		);
	}
	return normalizeXdebugModes( value );
}

/**
 * @param {?string}               phpVersion PHP version, or null for the image default.
 * @param {'development'|'tests'} [env]      Environment that uses `phpVersion`, named in the error.
 * @throws {Error} When Xdebug does not run on that PHP version.
 */
function assertXdebugSupported( phpVersion, env ) {
	if ( supportsXdebug( phpVersion ) ) {
		return;
	}
	if ( env ) {
		throw new Error(
			`Xdebug needs PHP 7.2 or later; the ${ env } environment uses PHP ${ phpVersion }.`
		);
	}
	throw new Error(
		`Xdebug needs PHP 7.2 or later; PHP ${ phpVersion } cannot run it.`
	);
}

/**
 * Environment variables that load Xdebug in a CLI container and point it at
 * an IDE on the host.
 *
 * @param {string} mode       Value for `XDEBUG_MODE`.
 * @param {string} clientHost Address of the host as seen from the container.
 * @return {Object<string, string>} Environment variables by name.
 */
function xdebugEnvironment( mode, clientHost ) {
	return {
		// The leading separator keeps PHP's default scan folder in the list.
		PHP_INI_SCAN_DIR: `:${ XDEBUG_CONF_DIR }`,
		XDEBUG_MODE: mode,
		XDEBUG_CONFIG: `client_host=${ clientHost } client_port=${ XDEBUG_CLIENT_PORT }`,
		PHP_IDE_CONFIG: `serverName=${ XDEBUG_SERVER_NAME }`,
	};
}

/**
 * Host paths of the per-environment folders this tool manages.
 *
 * @param {Object}                config Project config from `loadProjectConfig`.
 * @param {'development'|'tests'} env    Environment to resolve.
 * @return {{core: string, phpunitRepo: string, phpunit: string, reports: string, database: string}} Host folders by role.
 */
function environmentPaths( config, env ) {
	const state = config.stateDirectoryPath;
	const prefix = env === 'tests' ? 'tests-' : '';
	const { coreSource } = config.env[ env ];
	// When both environments share one core source, tests get a copy so each
	// install keeps its own wp-config.php.
	const useTestsCopy = env === 'tests' && hasSharedCoreSource( config );
	const core = useTestsCopy ? coreSource.testsPath : coreSource.path;
	const phpunitRepo = path.join( state, `${ prefix }WordPress-PHPUnit` );

	return {
		core,
		phpunitRepo,
		phpunit: path.join( phpunitRepo, 'tests', 'phpunit' ),
		reports: path.join( state, 'reports', env ),
		database: path.join( state, `${ prefix }mysql` ),
	};
}

/**
 * Bind mounts for an environment's WordPress and CLI containers: core first,
 * then PHPUnit, mappings, plugins and themes nested on top of it.
 *
 * @param {Object}                config
 * @param {'development'|'tests'} env
 * @return {string[]} `host:container` pairs.
 */
function environmentMounts( config, env ) {
	const envConfig = config.env[ env ];
	const paths = environmentPaths( config, env );
	const mounts = [
		`${ paths.core }:/var/www/html`,
		`${ paths.phpunit }:${ PHPUNIT_CONTAINER_PATH }`,
		...Object.entries( envConfig.mappings ).map(
			( [ wpDir, source ] ) => `${ source.path }:/var/www/html/${ wpDir }`
		),
		...envConfig.pluginSources.map(
			( source ) =>
				`${ source.path }:/var/www/html/wp-content/plugins/${ source.basename }`
		),
		...envConfig.themeSources.map(
			( source ) =>
				`${ source.path }:/var/www/html/wp-content/themes/${ source.basename }`
		),
	];
	return [ ...new Set( mounts ) ];
}

/**
 * @param {'development'|'tests'} env    Environment to resolve.
 * @param {string}                dbHost Database container IP.
 * @return {Object<string, string>} Database environment variables by name.
 */
function databaseEnvironment( env, dbHost ) {
	return {
		...dbEnv.credentials,
		WORDPRESS_DB_NAME: databaseName( env ),
		WORDPRESS_DB_HOST: dbHost,
		WP_TESTS_DIR: PHPUNIT_CONTAINER_PATH,
	};
}

function envArgs( environment ) {
	return Object.entries( environment ).flatMap( ( [ key, value ] ) => [
		'-e',
		`${ key }=${ value }`,
	] );
}

function mountArgs( mounts ) {
	return mounts.flatMap( ( mount ) => [ '-v', mount ] );
}

/**
 * @param {'development'|'tests'} env Environment the database serves.
 * @return {string} Name of the WordPress database of `env`.
 */
function databaseName( env ) {
	return env === 'tests'
		? dbEnv.tests.WORDPRESS_DB_NAME
		: dbEnv.development.WORDPRESS_DB_NAME;
}

/**
 * The MariaDB server of one environment, with its data folder bind-mounted
 * from the state folder. It runs as 999:999 because a virtiofs bind mount
 * rejects the image entrypoint's chown of the data directory.
 *
 * @param {Object}                config         Project configuration.
 * @param {'development'|'tests'} env            Environment the database serves.
 * @param {Object}                [options]
 * @param {?number}               [options.port] Host port for MariaDB.
 * @return {string[]} Arguments for `container run`.
 */
function runDatabaseArgs( config, env, { port = null } = {} ) {
	const args = [
		'run',
		'-d',
		'--rm',
		'--progress',
		'none',
		'--name',
		databaseContainerName( config.projectId, env ),
		'--user',
		'999:999',
		...labelArgs( projectLabels( config.projectId, 'mysql', env ) ),
		'-v',
		`${ environmentPaths( config, env ).database }:/var/lib/mysql`,
		'-e',
		`MARIADB_ROOT_PASSWORD=${ DB_ROOT_PASSWORD }`,
		'-e',
		`MARIADB_DATABASE=${ databaseName( env ) }`,
	];
	if ( port ) {
		args.push(
			'-p',
			`${ DATABASE_PUBLISH_ADDRESS }:${ port }:${ MYSQL_CONTAINER_PORT }`
		);
	}
	args.push( databaseImage( config, env ) );
	return args;
}

/**
 * The phpMyAdmin server of one environment, logged in as the database root.
 * The `LABEL_DB_HOST` label records the database address it was started
 * with, so a database that moves to another address is noticed.
 *
 * @param {Object}                config       Project configuration.
 * @param {'development'|'tests'} env          Environment the server serves.
 * @param {string}                dbHost       IP address of the environment's database.
 * @param {Object}                options
 * @param {number}                options.port Host port for phpMyAdmin.
 * @return {string[]} Arguments for `container run`.
 */
function runPhpmyadminArgs( config, env, dbHost, { port } ) {
	const labels = projectLabels( config.projectId, 'phpmyadmin', env );
	labels[ LABEL_DB_HOST ] = dbHost;
	return [
		'run',
		'-d',
		'--rm',
		'--progress',
		'none',
		'--name',
		phpmyadminContainerName( config.projectId, env ),
		...labelArgs( labels ),
		'-p',
		`${ DATABASE_PUBLISH_ADDRESS }:${ port }:${ HTTP_CONTAINER_PORT }`,
		...envArgs( {
			PMA_HOST: dbHost,
			PMA_PORT: MYSQL_CONTAINER_PORT,
			PMA_USER: 'root',
			PMA_PASSWORD: DB_ROOT_PASSWORD,
		} ),
		PHPMYADMIN_IMAGE,
	];
}

/**
 * @param {Object}                config Project configuration.
 * @param {'development'|'tests'} env    Environment the database serves.
 * @return {string[]} `container exec` args that exit 0 once MariaDB accepts TCP connections.
 */
function databasePingArgs( config, env ) {
	return [
		'exec',
		databaseContainerName( config.projectId, env ),
		'mariadb-admin',
		'ping',
		'-h',
		'127.0.0.1',
		'--protocol=tcp',
		'-uroot',
		`-p${ DB_ROOT_PASSWORD }`,
	];
}

/**
 * @param {Object}                config Project configuration.
 * @param {'development'|'tests'} env    Environment the database serves.
 * @return {string[]} `container exec` args that create the environment's WordPress database when it is missing.
 */
function createDatabaseArgs( config, env ) {
	return [
		'exec',
		databaseContainerName( config.projectId, env ),
		'mariadb',
		'-h',
		'127.0.0.1',
		'--protocol=tcp',
		'-uroot',
		`-p${ DB_ROOT_PASSWORD }`,
		'-e',
		`CREATE DATABASE IF NOT EXISTS \`${ databaseName( env ) }\``,
	];
}

/**
 * Environment variables that turn on Xdebug in a web container built from
 * `xdebugWordPressImage`.
 *
 * @param {string} mode       Xdebug modes from `parseXdebugMode`.
 * @param {string} clientHost Address of the host as seen from the container.
 * @return {Object<string, string>} Environment variables by name.
 */
function webXdebugEnvironment( mode, clientHost ) {
	return {
		[ WEB_XDEBUG_MODE_VARIABLE ]: mode,
		[ WEB_XDEBUG_HOST_VARIABLE ]: clientHost,
		PHP_IDE_CONFIG: `serverName=${ XDEBUG_SERVER_NAME }`,
	};
}

/**
 * The long-running web container of an environment. With Xdebug it runs the
 * locally built Xdebug image and records the modes in the `LABEL_XDEBUG` label.
 *
 * @param {Object}                config               Project configuration.
 * @param {'development'|'tests'} env                  Environment to run.
 * @param {string}                dbHost               Database container IP.
 * @param {Object}                [options]
 * @param {?string}               [options.xdebug]     Xdebug modes from `parseXdebugMode`. Null runs the stock image.
 * @param {string}                [options.clientHost] Host address Xdebug connects to.
 * @return {string[]} Arguments for `container run`.
 */
function runWordPressArgs(
	config,
	env,
	dbHost,
	{ xdebug = null, clientHost } = {}
) {
	const envConfig = config.env[ env ];
	const labels = projectLabels( config.projectId, 'wordpress', env );
	const environment = databaseEnvironment( env, dbHost );
	let image = wordpressImage( envConfig.phpVersion );
	if ( xdebug ) {
		labels[ LABEL_XDEBUG ] = xdebug;
		Object.assign(
			environment,
			webXdebugEnvironment( xdebug, clientHost )
		);
		image = xdebugWordPressImage( envConfig.phpVersion );
	}
	return [
		'run',
		'-d',
		'--rm',
		'--progress',
		'none',
		'--name',
		wordpressContainerName( config.projectId, env ),
		...labelArgs( labels ),
		'-p',
		`${ PUBLISH_ADDRESS }:${ envConfig.port }:${ HTTP_CONTAINER_PORT }`,
		...envArgs( environment ),
		...mountArgs( environmentMounts( config, env ) ),
		image,
	];
}

/**
 * A one-shot CLI container with the same mounts and database settings as the
 * environment's WordPress container.
 *
 * @param {Object}                config
 * @param {'development'|'tests'} env
 * @param {string}                dbHost
 * @param {string[]}              command
 * @param {Object}                [options]
 * @param {string}                [options.cwd]         Working directory inside the container.
 * @param {boolean}               [options.interactive] Keep stdin open.
 * @param {boolean}               [options.tty]         Allocate a TTY.
 * @param {string}                [options.name]        Container name, so a timed-out run can be stopped.
 * @param {?string}               [options.xdebug]      Xdebug modes from `parseXdebugMode`. Null leaves Xdebug unloaded.
 * @param {string}                [options.clientHost]  Host address Xdebug connects to.
 * @return {string[]} Arguments for `container run`.
 * @throws {Error} When `xdebug` is set and the environment's PHP version cannot run Xdebug.
 */
function runCLIArgs(
	config,
	env,
	dbHost,
	command,
	{ cwd, interactive, tty, name, xdebug = null, clientHost } = {}
) {
	const envConfig = config.env[ env ];
	const environment = databaseEnvironment( env, dbHost );
	if ( xdebug ) {
		assertXdebugSupported( envConfig.phpVersion, env );
		Object.assign( environment, xdebugEnvironment( xdebug, clientHost ) );
	}
	const args = [ 'run', '--rm', '--progress', 'none' ];
	if ( interactive ) {
		args.push( '-i' );
	}
	if ( tty ) {
		args.push( '-t' );
	}
	if ( name ) {
		args.push( '--name', name );
	}
	args.push(
		...labelArgs( projectLabels( config.projectId, 'cli', env ) ),
		...envArgs( environment ),
		...mountArgs( [
			...environmentMounts( config, env ),
			`${ environmentPaths( config, env ).reports }:${ REPORTS_CONTAINER_PATH }`,
		] ),
		'-w',
		resolveContainerCwd( cwd ),
		cliImage( envConfig.phpVersion ),
		...command
	);
	return args;
}

/**
 * @param {Object} config Project configuration.
 * @return {boolean} Whether development and tests use the same core source.
 */
function hasSharedCoreSource( config ) {
	const development = config.env.development.coreSource;
	const tests = config.env.tests.coreSource;
	return development.path === tests.path;
}

/**
 * @param {Object} record        Container record from `toRecord`.
 * @param {number} containerPort Port inside the container.
 * @return {?number} The host port published for `containerPort`, or null.
 */
function publishedPort( record, containerPort ) {
	const published = ( record?.ports || [] ).find(
		( port ) => port.containerPort === containerPort
	);
	return published ? published.hostPort : null;
}

/**
 * Host ports the project's running containers publish, by environment: the
 * WordPress port as `http`, the MariaDB port as `mysql` and the phpMyAdmin
 * port as `phpmyadmin`.
 *
 * @param {string}   projectId  Id of the project.
 * @param {Object[]} containers The project's container records.
 * @return {Object<string, {http?: number, mysql?: number, phpmyadmin?: number}>} Ports by environment.
 */
function runningPorts( projectId, containers ) {
	const byName = new Map(
		containers
			.filter( ( record ) => record.state === 'running' )
			.map( ( record ) => [ record.name, record ] )
	);
	const ports = {};
	for ( const env of ENVIRONMENTS ) {
		ports[ env ] = {};
		const http = publishedPort(
			byName.get( wordpressContainerName( projectId, env ) ),
			HTTP_CONTAINER_PORT
		);
		const mysql = publishedPort(
			byName.get( databaseContainerName( projectId, env ) ),
			MYSQL_CONTAINER_PORT
		);
		const phpmyadmin = publishedPort(
			byName.get( phpmyadminContainerName( projectId, env ) ),
			HTTP_CONTAINER_PORT
		);
		if ( http ) {
			ports[ env ].http = http;
		}
		if ( phpmyadmin ) {
			ports[ env ].phpmyadmin = phpmyadmin;
		}
		if ( mysql ) {
			ports[ env ].mysql = mysql;
		}
	}
	return ports;
}

/**
 * Points an environment's config at the WordPress port it publishes. The
 * port in `WP_TESTS_DOMAIN`, `WP_SITEURL` and `WP_HOME` moves along when it
 * is the configured port; a URL with another port stays as written.
 *
 * @param {Object}                config Project configuration.
 * @param {'development'|'tests'} env    Environment to update.
 * @param {number}                port   Published WordPress port.
 * @return {Object} A copy of `config` with the environment's port and URLs replaced.
 */
function withWordPressPort( config, env, port ) {
	const envConfig = config.env[ env ];
	if ( ! port || port === envConfig.port ) {
		return config;
	}
	const constants = { ...envConfig.config };
	for ( const name of URL_CONSTANTS ) {
		const value = constants[ name ];
		if ( typeof value !== 'string' ) {
			continue;
		}
		const parts = value.match( URL_PATTERN );
		if ( ! parts ) {
			continue;
		}
		const [ , origin, urlPort, rest ] = parts;
		const urlPortNumber = Number( urlPort );
		const followsPort =
			urlPort === undefined || urlPortNumber === envConfig.port;
		if ( followsPort ) {
			constants[ name ] = `${ origin }:${ port }${ rest }`;
		}
	}
	return {
		...config,
		env: {
			...config.env,
			[ env ]: { ...envConfig, port, config: constants },
		},
	};
}

/**
 * Drops the WordPress port from `WP_TESTS_DOMAIN`, `WP_SITEURL` and `WP_HOME`
 * where it is `port`, the port those URLs follow. A URL with another port,
 * or none, stays as written.
 *
 * @param {Object}  constants wp-config constants of one environment.
 * @param {?number} port      The environment's WordPress port.
 * @return {Object} A copy of `constants` with those ports removed.
 */
function withoutWordPressPort( constants, port ) {
	const result = { ...constants };
	for ( const name of URL_CONSTANTS ) {
		const value = result[ name ];
		if ( typeof value !== 'string' ) {
			continue;
		}
		const parts = value.match( URL_PATTERN );
		if ( ! parts ) {
			continue;
		}
		const [ , origin, urlPort, rest ] = parts;
		const urlPortNumber = Number( urlPort );
		if ( urlPort !== undefined && urlPortNumber === port ) {
			result[ name ] = `${ origin }${ rest }`;
		}
	}
	return result;
}

/**
 * @param {?string} cwd Path relative to the WordPress root, or absolute.
 * @return {string} Absolute path inside the container.
 */
function resolveContainerCwd( cwd ) {
	if ( ! cwd ) {
		return '/var/www/html';
	}
	return path.posix.isAbsolute( cwd )
		? cwd
		: path.posix.join( '/var/www/html', cwd );
}

module.exports = {
	ENVIRONMENTS,
	LABEL_DB_HOST,
	LABEL_ENV,
	LABEL_PROJECT,
	LABEL_ROLE,
	LABEL_XDEBUG,
	HTTP_CONTAINER_PORT,
	MYSQL_CONTAINER_PORT,
	DATABASE_PUBLISH_ADDRESS,
	PUBLISH_ADDRESS,
	PHPMYADMIN_IMAGE,
	PHPUNIT_CONTAINER_PATH,
	REPORTS_CONTAINER_PATH,
	XDEBUG_CLIENT_PORT,
	XDEBUG_MODES,
	assertXdebugSupported,
	cliContainerfile,
	cliImage,
	containerNames,
	createDatabaseArgs,
	databaseContainerName,
	databaseEnvironment,
	databaseImage,
	databasePingArgs,
	environmentMounts,
	environmentPaths,
	hasSharedCoreSource,
	isLocalImageFor,
	isPhpmyadminEnabled,
	localImage,
	normalizeXdebugModes,
	parseXdebugMode,
	phpExtensionPackages,
	phpmyadminContainerName,
	publishedPort,
	resolveContainerCwd,
	runningPorts,
	runCLIArgs,
	runDatabaseArgs,
	runPhpmyadminArgs,
	runWordPressArgs,
	supportsXdebug,
	wordpressContainerName,
	withWordPressPort,
	withoutWordPressPort,
	wordpressImage,
	xdebugWordPressContainerfile,
	xdebugWordPressImage,
};
