'use strict';
const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const crypto = require( 'crypto' );
const recipes = require( '../../lib/runtime/recipes' );
const { makeConfig } = require( '../helpers/config' );

function valuesAfter( args, flag ) {
	return args.flatMap( ( arg, index ) =>
		arg === flag ? [ args[ index + 1 ] ] : []
	);
}

test( 'tests core is a copy when both environments share a core source', () => {
	const config = makeConfig();

	assert.equal(
		recipes.environmentPaths( config, 'development' ).core,
		'/state/example-project/WordPress'
	);
	assert.equal(
		recipes.environmentPaths( config, 'tests' ).core,
		'/state/example-project/tests-WordPress'
	);
} );

test( 'tests core uses its own source when it differs', () => {
	const config = makeConfig();
	config.env.tests = {
		...config.env.tests,
		coreSource: {
			type: 'local',
			path: '/projects/wordpress-develop/build',
			basename: 'build',
			testsPath: '/unused',
		},
	};

	assert.equal(
		recipes.environmentPaths( config, 'tests' ).core,
		'/projects/wordpress-develop/build'
	);
} );

test( 'environment mounts put core first, then PHPUnit, mappings, plugins and themes', () => {
	const config = makeConfig();
	config.env.development.mappings = {
		'wp-content/mu-plugins': { type: 'local', path: '/projects/mu' },
	};
	config.env.development.themeSources = [
		{ type: 'local', path: '/projects/theme', basename: 'theme' },
	];

	assert.deepEqual( recipes.environmentMounts( config, 'development' ), [
		'/state/example-project/WordPress:/var/www/html',
		'/state/example-project/WordPress-PHPUnit/tests/phpunit:/wordpress-phpunit',
		'/projects/mu:/var/www/html/wp-content/mu-plugins',
		'/projects/example-plugin:/var/www/html/wp-content/plugins/example-plugin',
		'/projects/theme:/var/www/html/wp-content/themes/theme',
	] );
} );

test( 'database runs as 999:999 with a bind-mounted data folder and project label', () => {
	const args = recipes.runDatabaseArgs( makeConfig(), 'development' );

	assert.deepEqual( valuesAfter( args, '--name' ), [
		'example-project-mysql',
	] );
	assert.deepEqual( valuesAfter( args, '--user' ), [ '999:999' ] );
	assert.deepEqual( valuesAfter( args, '-v' ), [
		'/state/example-project/mysql:/var/lib/mysql',
	] );
	assert.ok(
		valuesAfter( args, '--label' ).includes(
			'dev.wp-env-container.project=example-project'
		)
	);
	assert.equal( args.at( -1 ), 'mariadb:lts' );
	assert.deepEqual( valuesAfter( args, '-p' ), [] );
} );

test( 'database publishes its port on loopback only', () => {
	const args = recipes.runDatabaseArgs( makeConfig(), 'development', {
		port: 13306,
	} );

	assert.deepEqual( valuesAfter( args, '-p' ), [ '127.0.0.1:13306:3306' ] );
} );

test( 'the tests database has its own container, data folder, database and image', () => {
	const config = makeConfig();
	config.env.tests.mariadbVersion = '10.11';
	const args = recipes.runDatabaseArgs( config, 'tests', { port: 13307 } );

	assert.deepEqual( valuesAfter( args, '--name' ), [
		'example-project-tests-mysql',
	] );
	assert.deepEqual( valuesAfter( args, '-v' ), [
		'/state/example-project/tests-mysql:/var/lib/mysql',
	] );
	assert.ok(
		valuesAfter( args, '-e' ).includes( 'MARIADB_DATABASE=tests-wordpress' )
	);
	assert.ok(
		valuesAfter( args, '--label' ).includes(
			'dev.wp-env-container.env=tests'
		)
	);
	assert.deepEqual( valuesAfter( args, '-p' ), [ '127.0.0.1:13307:3306' ] );
	assert.equal( args.at( -1 ), 'mariadb:10.11' );
	assert.deepEqual(
		recipes.databasePingArgs( config, 'tests' ).slice( 0, 2 ),
		[ 'exec', 'example-project-tests-mysql' ]
	);
	assert.equal(
		recipes.createDatabaseArgs( config, 'tests' ).at( -1 ),
		'CREATE DATABASE IF NOT EXISTS `tests-wordpress`'
	);
	assert.equal(
		recipes.createDatabaseArgs( config, 'development' ).at( -1 ),
		'CREATE DATABASE IF NOT EXISTS `wordpress`'
	);
} );

test( 'runningPorts reads the published ports of running containers only', () => {
	const published = ( hostPort, containerPort ) => [
		{ hostAddress: '0.0.0.0', hostPort, containerPort, proto: 'tcp' },
	];
	const ports = recipes.runningPorts( 'example-project', [
		{
			name: 'example-project-wordpress',
			state: 'running',
			ports: published( 8890, 80 ),
		},
		{
			name: 'example-project-mysql',
			state: 'running',
			ports: published( 50001, 3306 ),
		},
		{
			name: 'example-project-tests-wordpress',
			state: 'stopped',
			ports: published( 8891, 80 ),
		},
		{
			name: 'example-project-tests-mysql',
			state: 'running',
			ports: [],
		},
	] );

	assert.deepEqual( ports, {
		development: { http: 8890, mysql: 50001 },
		tests: {},
	} );
} );

test( 'runPhpmyadminArgs publishes on loopback and logs in to the environment database', () => {
	const args = recipes.runPhpmyadminArgs(
		makeConfig(),
		'tests',
		'192.168.64.10',
		{ port: 50011 }
	);

	assert.deepEqual( args.slice( 0, 7 ), [
		'run',
		'-d',
		'--rm',
		'--progress',
		'none',
		'--name',
		'example-project-tests-phpmyadmin',
	] );
	assert.equal( args[ args.indexOf( '-p' ) + 1 ], '127.0.0.1:50011:80' );
	assert.equal( args.at( -1 ), 'phpmyadmin' );
	const labels = valuesAfter( args, '--label' ).sort();
	assert.deepEqual( labels, [
		'dev.wp-env-container.db-host=192.168.64.10',
		'dev.wp-env-container.env=tests',
		'dev.wp-env-container.project=example-project',
		'dev.wp-env-container.role=phpmyadmin',
	] );
	const environment = valuesAfter( args, '-e' ).sort();
	assert.deepEqual( environment, [
		'PMA_HOST=192.168.64.10',
		'PMA_PASSWORD=password',
		'PMA_PORT=3306',
		'PMA_USER=root',
	] );
} );

test( 'phpmyadminContainerName names one container per environment', () => {
	assert.equal(
		recipes.phpmyadminContainerName( 'example-project', 'development' ),
		'example-project-phpmyadmin'
	);
	assert.equal(
		recipes.phpmyadminContainerName( 'example-project', 'tests' ),
		'example-project-tests-phpmyadmin'
	);
} );

test( 'runningPorts reads the published phpMyAdmin ports', () => {
	const ports = recipes.runningPorts( 'example-project', [
		{
			name: 'example-project-phpmyadmin',
			state: 'running',
			ports: [
				{
					hostAddress: '127.0.0.1',
					hostPort: 50011,
					containerPort: 80,
					proto: 'tcp',
				},
			],
		},
	] );

	assert.deepEqual( ports, {
		development: { phpmyadmin: 50011 },
		tests: {},
	} );
} );

test( 'withWordPressPort moves the configured port in the URL constants', () => {
	const config = makeConfig();
	config.env.development.config.WP_TESTS_DOMAIN = 'localhost:8888';
	config.env.tests.config.WP_HOME = 'http://example.test:9000/blog';

	const moved = recipes.withWordPressPort( config, 'development', 8890 );

	assert.equal( moved.env.development.port, 8890 );
	assert.deepEqual( moved.env.development.config, {
		WP_DEBUG: true,
		WP_SITEURL: 'http://localhost:8890',
		WP_HOME: 'http://localhost:8890',
		WP_TESTS_DOMAIN: 'localhost:8890',
	} );
	assert.equal( config.env.development.port, 8888, 'the input is kept' );

	const tests = recipes.withWordPressPort( config, 'tests', 8891 );
	assert.equal( tests.env.tests.config.WP_SITEURL, 'http://localhost:8891' );
	assert.equal(
		tests.env.tests.config.WP_HOME,
		'http://example.test:9000/blog',
		'a URL with another port stays'
	);
	assert.equal( recipes.withWordPressPort( config, 'tests', 8889 ), config );
} );

test( 'tests WordPress uses the tests database, tests port and IP database host', () => {
	const config = makeConfig();
	config.env.tests.phpVersion = '8.3';
	const args = recipes.runWordPressArgs( config, 'tests', '192.168.64.9' );

	assert.deepEqual( valuesAfter( args, '--name' ), [
		'example-project-tests-wordpress',
	] );
	assert.deepEqual( valuesAfter( args, '-p' ), [ '0.0.0.0:8889:80' ] );
	const env = valuesAfter( args, '-e' );
	assert.ok( env.includes( 'WORDPRESS_DB_NAME=tests-wordpress' ) );
	assert.ok( env.includes( 'WORDPRESS_DB_HOST=192.168.64.9' ) );
	assert.ok( env.includes( 'WP_TESTS_DIR=/wordpress-phpunit' ) );
	assert.ok(
		valuesAfter( args, '--label' ).includes(
			'dev.wp-env-container.env=tests'
		)
	);
	assert.equal( args.at( -1 ), 'wordpress:php8.3' );
} );

test( 'CLI args resolve the working directory and append the command after the image', () => {
	const config = makeConfig();
	const args = recipes.runCLIArgs(
		config,
		'development',
		'192.168.64.9',
		[ 'wp', 'plugin', 'list' ],
		{
			cwd: 'wp-content/plugins/example-plugin',
			name: 'run-1',
		}
	);

	assert.deepEqual( valuesAfter( args, '-w' ), [
		'/var/www/html/wp-content/plugins/example-plugin',
	] );
	assert.deepEqual( valuesAfter( args, '--name' ), [ 'run-1' ] );
	assert.ok(
		valuesAfter( args, '-v' ).includes(
			'/state/example-project/reports/development:/wp-env-container-reports'
		)
	);
	assert.deepEqual( args.slice( -4 ), [
		recipes.cliImage( null ),
		'wp',
		'plugin',
		'list',
	] );
	assert.ok( ! args.includes( '-i' ) );
	assert.ok( ! args.includes( '-t' ) );
	assert.ok(
		! valuesAfter( args, '-e' ).some( ( value ) =>
			/^(PHP_INI_SCAN_DIR|XDEBUG_)/.test( value )
		)
	);
} );

test( 'CLI args load Xdebug and point it at the host when asked', () => {
	const config = makeConfig();
	const args = recipes.runCLIArgs(
		config,
		'tests',
		'192.168.64.9',
		[ 'php', '-m' ],
		{
			xdebug: 'debug,coverage',
			clientHost: '192.168.64.1',
		}
	);

	const env = valuesAfter( args, '-e' );
	assert.ok(
		env.includes( 'PHP_INI_SCAN_DIR=:/usr/local/etc/php/conf.d-xdebug' )
	);
	assert.ok( env.includes( 'XDEBUG_MODE=debug,coverage' ) );
	assert.ok(
		env.includes(
			'XDEBUG_CONFIG=client_host=192.168.64.1 client_port=9003'
		)
	);
	assert.ok( env.includes( 'PHP_IDE_CONFIG=serverName=wp-env-container' ) );
	assert.ok( env.includes( 'WORDPRESS_DB_HOST=192.168.64.9' ) );
} );

test( 'CLI args refuse Xdebug on PHP older than 7.2', () => {
	const config = makeConfig();
	config.env.tests.phpVersion = '7.1';

	assert.throws(
		() =>
			recipes.runCLIArgs( config, 'tests', '192.168.64.9', [ 'php' ], {
				xdebug: 'debug',
				clientHost: '192.168.64.1',
			} ),
		{
			message:
				'Xdebug needs PHP 7.2 or later; the tests environment uses PHP 7.1.',
		}
	);
} );

test( 'parseXdebugMode defaults to debug and keeps a valid mode list', () => {
	assert.equal( recipes.parseXdebugMode( true ), 'debug' );
	assert.equal( recipes.parseXdebugMode( '' ), 'debug' );
	assert.equal( recipes.parseXdebugMode( 'coverage' ), 'coverage' );
	assert.equal(
		recipes.parseXdebugMode( 'coverage,debug' ),
		'coverage,debug'
	);
	assert.equal( recipes.parseXdebugMode( 'off' ), 'off' );
} );

test( 'parseXdebugMode sorts the modes and drops repeats', () => {
	assert.equal(
		recipes.parseXdebugMode( 'develop,debug,develop' ),
		'debug,develop'
	);
	assert.equal(
		recipes.parseXdebugMode( 'trace,coverage' ),
		'coverage,trace'
	);
} );

test( 'parseXdebugMode rejects unknown modes', () => {
	for ( const value of [
		'bogus',
		'debug,',
		'debug, coverage',
		'DEBUG',
		42,
		false,
	] ) {
		assert.throws( () => recipes.parseXdebugMode( value ), {
			message: `Invalid Xdebug mode "${ value }". Use a comma-separated list of: off, develop, coverage, debug, gcstats, profile, trace.`,
		} );
	}
} );

test( 'CLI args keep stdin open and allocate a TTY only when asked', () => {
	const config = makeConfig();
	const run = ( options ) =>
		recipes.runCLIArgs(
			config,
			'development',
			'192.168.64.9',
			[ 'wp' ],
			options
		);

	const piped = run( { interactive: true } );
	assert.ok( piped.includes( '-i' ) );
	assert.ok( ! piped.includes( '-t' ) );

	const terminal = run( { interactive: true, tty: true } );
	assert.ok( terminal.includes( '-i' ) );
	assert.ok( terminal.includes( '-t' ) );
} );

test( 'image names follow the PHP version', () => {
	assert.equal( recipes.wordpressImage( null ), 'wordpress:latest' );
	assert.equal( recipes.wordpressImage( '8.2' ), 'wordpress:php8.2' );
	assert.match(
		recipes.cliImage( '8.2' ),
		/^wp-env-container\/cli:php8\.2-[0-9a-f]{8}$/
	);
	assert.match(
		recipes.cliImage( null ),
		/^wp-env-container\/cli:latest-[0-9a-f]{8}$/
	);
	assert.match(
		recipes.cliContainerfile( '8.2' ),
		/^FROM wordpress:cli-php8\.2$/m
	);
	assert.match( recipes.cliContainerfile( null ), /^FROM wordpress:cli$/m );
} );

test( 'the CLI image tag is a hash of its Containerfile', () => {
	const hash = crypto
		.createHash( 'sha256' )
		.update( recipes.cliContainerfile( '8.3' ) )
		.digest( 'hex' )
		.slice( 0, 8 );

	assert.equal(
		recipes.cliImage( '8.3' ),
		`wp-env-container/cli:php8.3-${ hash }`
	);
	assert.notEqual( recipes.cliImage( '8.3' ), recipes.cliImage( '8.2' ) );
	assert.notEqual(
		recipes.cliImage( '7.4' ).split( '-' ).pop(),
		recipes.cliImage( '8.3' ).split( '-' ).pop()
	);
} );

test( 'isLocalImageFor matches every recipe tag of one kind and PHP version', () => {
	assert.ok(
		recipes.isLocalImageFor( 'wp-env-container/cli:php8.3', 'cli', '8.3' )
	);
	assert.ok(
		recipes.isLocalImageFor(
			'wp-env-container/cli:php8.3-0123abcd',
			'cli',
			'8.3'
		)
	);
	assert.ok(
		recipes.isLocalImageFor(
			'wp-env-container/cli:latest-0123abcd',
			'cli',
			null
		)
	);
	assert.ok(
		recipes.isLocalImageFor( 'wp-env-container/cli:latest', 'cli', null )
	);
	assert.ok(
		! recipes.isLocalImageFor(
			'wp-env-container/cli:php8.30-0123abcd',
			'cli',
			'8.3'
		)
	);
	assert.ok(
		! recipes.isLocalImageFor(
			'wp-env-container/cli:php8.3-custom',
			'cli',
			'8.3'
		)
	);
	assert.ok(
		! recipes.isLocalImageFor( 'wp-env-container/cli:php8.2', 'cli', '8.3' )
	);
	assert.ok( ! recipes.isLocalImageFor( 'other/cli:php8.3', 'cli', '8.3' ) );
} );

test( 'isLocalImageFor keeps CLI and web images apart', () => {
	const web = recipes.xdebugWordPressImage( '8.3' );

	assert.match( web, /^wp-env-container\/wordpress:php8\.3-[0-9a-f]{8}$/ );
	assert.ok( recipes.isLocalImageFor( web, 'wordpress', '8.3' ) );
	assert.ok( ! recipes.isLocalImageFor( web, 'cli', '8.3' ) );
	assert.ok(
		! recipes.isLocalImageFor(
			recipes.cliImage( '8.3' ),
			'wordpress',
			'8.3'
		)
	);
} );

test( 'the web Xdebug image installs the CLI image Xdebug release and reads its settings from the environment', () => {
	const php74 = recipes.xdebugWordPressContainerfile( '7.4' );
	const php83 = recipes.xdebugWordPressContainerfile( '8.3' );
	const hash = crypto
		.createHash( 'sha256' )
		.update( php83 )
		.digest( 'hex' )
		.slice( 0, 8 );

	assert.match( php74, /^FROM wordpress:php7\.4$/m );
	assert.match( php74, /pecl install xdebug-3\.1\.6 / );
	assert.match( php83, /pecl install xdebug / );
	assert.match( php83, /docker-php-ext-enable xdebug/ );
	assert.match(
		php83,
		/'xdebug\.mode=\$\{WP_ENV_CONTAINER_XDEBUG_MODE\}' 'xdebug\.client_host=\$\{WP_ENV_CONTAINER_XDEBUG_CLIENT_HOST\}' 'xdebug\.client_port=9003' 'xdebug\.start_with_request=yes' 'xdebug\.log_level=0'/
	);
	assert.match( php83, /'PassEnv PHP_IDE_CONFIG'/ );
	assert.equal(
		recipes.xdebugWordPressImage( '8.3' ),
		`wp-env-container/wordpress:php8.3-${ hash }`
	);
	assert.throws( () => recipes.xdebugWordPressContainerfile( '7.1' ), {
		message: 'Xdebug needs PHP 7.2 or later; PHP 7.1 cannot run it.',
	} );
} );

test( 'WordPress with Xdebug runs the web Xdebug image and records the modes', () => {
	const config = makeConfig();
	config.env.development.phpVersion = '8.3';
	const args = recipes.runWordPressArgs(
		config,
		'development',
		'192.168.64.9',
		{ xdebug: 'debug,develop', clientHost: '192.168.64.1' }
	);
	const plain = recipes.runWordPressArgs(
		config,
		'development',
		'192.168.64.9'
	);

	const env = valuesAfter( args, '-e' );
	assert.ok( env.includes( 'WP_ENV_CONTAINER_XDEBUG_MODE=debug,develop' ) );
	assert.ok(
		env.includes( 'WP_ENV_CONTAINER_XDEBUG_CLIENT_HOST=192.168.64.1' )
	);
	assert.ok( env.includes( 'PHP_IDE_CONFIG=serverName=wp-env-container' ) );
	assert.ok(
		valuesAfter( args, '--label' ).includes(
			'dev.wp-env-container.xdebug=debug,develop'
		)
	);
	assert.equal( args.at( -1 ), recipes.xdebugWordPressImage( '8.3' ) );
	assert.equal( plain.at( -1 ), 'wordpress:php8.3' );
	assert.ok(
		! valuesAfter( plain, '--label' ).some( ( label ) =>
			label.startsWith( 'dev.wp-env-container.xdebug=' )
		)
	);
	assert.ok(
		! valuesAfter( plain, '-e' ).some( ( value ) =>
			value.startsWith( 'WP_ENV_CONTAINER_XDEBUG_' )
		)
	);
} );

function extensionsStep( phpVersion ) {
	return (
		recipes
			.cliContainerfile( phpVersion )
			.split( '\nRUN ' )
			.find( ( step ) => step.includes( 'pecl' ) ) || null
	);
}

test( 'the Containerfile skips both extensions before PHP 7.1', () => {
	const containerfile = recipes.cliContainerfile( '7.0' );

	assert.equal( extensionsStep( '7.0' ), null );
	assert.doesNotMatch( containerfile, /pcov|xdebug/ );
	assert.match( containerfile, /\nUSER www-data\n$/ );
} );

test( 'the Containerfile installs PCOV only on PHP 7.1', () => {
	const step = extensionsStep( '7.1' );

	assert.match( step, /pecl install pcov \\\n/ );
	assert.match( step, /docker-php-ext-enable pcov/ );
	assert.doesNotMatch( step, /xdebug/ );
} );

test( 'the Containerfile installs Xdebug 3.1.6 on PHP 7.4 and the latest Xdebug on PHP 8', () => {
	assert.match(
		extensionsStep( '7.4' ),
		/pecl install pcov xdebug-3\.1\.6 /
	);
	assert.match( extensionsStep( '8.3' ), /pecl install pcov xdebug / );
	assert.match( extensionsStep( null ), /pecl install pcov xdebug / );
} );

test( 'the Containerfile enables PCOV and leaves Xdebug to an extra scan folder', () => {
	for ( const phpVersion of [ '7.4', '8.3', null ] ) {
		const containerfile = recipes.cliContainerfile( phpVersion );
		const step = extensionsStep( phpVersion );

		assert.match(
			step,
			/^apk add --no-cache --virtual \.build-deps \$PHPIZE_DEPS linux-headers \\\n/
		);
		assert.match( step, /docker-php-ext-enable pcov \\\n/ );
		assert.doesNotMatch( step, /docker-php-ext-enable xdebug/ );
		assert.match(
			step,
			/printf '%s\\n' 'zend_extension=xdebug' 'pcov\.enabled=0' 'xdebug\.start_with_request=yes' 'xdebug\.log_level=0' > \/usr\/local\/etc\/php\/conf\.d-xdebug\/xdebug\.ini/
		);
		assert.match(
			step,
			/apk del \.build-deps \\\n && rm -rf \/tmp\/pear(\n|$)/
		);
		assert.ok(
			containerfile.indexOf( 'pecl install' ) >
				containerfile.indexOf( 'composer global require' )
		);
		assert.match( containerfile, /\nUSER www-data\n$/ );
	}
} );

test( 'the CLI entrypoint probes wp-cli subcommands with Xdebug off and no site', () => {
	const containerfile = recipes.cliContainerfile( '8.3' );

	assert.match(
		containerfile,
		/XDEBUG_MODE=off wp --path=\/dev\/null help "\$1"/
	);
	assert.match(
		containerfile,
		/\nENTRYPOINT \["wp-env-container-entrypoint"\]\n/
	);
} );

test( 'resolveContainerCwd keeps absolute paths and anchors relative ones at the WordPress root', () => {
	assert.equal( recipes.resolveContainerCwd(), '/var/www/html' );
	assert.equal(
		recipes.resolveContainerCwd( 'wp-content' ),
		'/var/www/html/wp-content'
	);
	assert.equal( recipes.resolveContainerCwd( '/tmp' ), '/tmp' );
} );

test( 'withoutWordPressPort drops the port the URL constants follow and keeps the rest', () => {
	const constants = {
		WP_DEBUG: true,
		WP_TESTS_DOMAIN: 'localhost:8890',
		WP_SITEURL: 'http://example.test:8890/blog',
		WP_HOME: 'http://example.test:9999',
	};

	assert.deepEqual( recipes.withoutWordPressPort( constants, 8890 ), {
		WP_DEBUG: true,
		WP_TESTS_DOMAIN: 'localhost',
		WP_SITEURL: 'http://example.test/blog',
		WP_HOME: 'http://example.test:9999',
	} );
	assert.equal( constants.WP_SITEURL, 'http://example.test:8890/blog' );
	assert.deepEqual(
		recipes.withoutWordPressPort( { WP_SITEURL: 'http://localhost' }, 80 ),
		{ WP_SITEURL: 'http://localhost' }
	);
} );
