'use strict';
const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const net = require( 'net' );
const {
	isPortFree,
	pickRandomPort,
	resolvePorts,
} = require( '../../lib/runtime/ports' );
const { makeConfig } = require( '../helpers/config' );

const ENVIRONMENTS = [ 'development', 'tests' ];

// `CI` changes the busy-port hint, so every test runs without it and the
// test that needs it sets it itself.
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
 * @param {number[]} busy Ports the fake check reports as taken.
 * @return {(port: number) => Promise<boolean>} Port check.
 */
function freeExcept( busy ) {
	return async ( port ) => ! busy.includes( port );
}

/**
 * @param {number[]} values Ports to hand out in order.
 * @return {() => Promise<number>} Random port source.
 */
function randomPorts( values ) {
	const queue = [ ...values ];
	return async () => queue.shift();
}

test( 'resolvePorts uses the configured ports when they are free', async () => {
	const resolved = await resolvePorts( makeConfig(), {
		environments: ENVIRONMENTS,
		autoPort: false,
		held: {},
		saved: {},
		isFree: freeExcept( [] ),
		randomPort: randomPorts( [ 50001, 50002 ] ),
	} );

	assert.deepEqual( resolved, {
		development: { http: 8888, mysql: 50001 },
		tests: { http: 8889, mysql: 50002 },
	} );
} );

test( 'resolvePorts rejects a busy WordPress port without autoPort', async () => {
	await assert.rejects(
		resolvePorts( makeConfig(), {
			environments: ENVIRONMENTS,
			autoPort: false,
			held: {},
			saved: {},
			isFree: freeExcept( [ 8888 ] ),
			randomPort: randomPorts( [ 50001, 50002 ] ),
		} ),
		{
			message:
				'Port 8888 (development) is already in use. Free it, set "port"/"testsPort" in .wp-env.json or WP_ENV_PORT/WP_ENV_TESTS_PORT, or enable automatic port selection with --auto-port or "autoPort": true.',
		}
	);
} );

test( 'resolvePorts leaves automatic port selection out of the hint when CI is set', async () => {
	process.env.CI = 'true';
	try {
		await assert.rejects(
			resolvePorts( makeConfig(), {
				environments: ENVIRONMENTS,
				autoPort: false,
				held: {},
				saved: {},
				isFree: freeExcept( [ 8888 ] ),
				randomPort: randomPorts( [ 50001, 50002 ] ),
			} ),
			{
				message:
					'Port 8888 (development) is already in use. Free it, or set "port"/"testsPort" in .wp-env.json or WP_ENV_PORT/WP_ENV_TESTS_PORT (automatic port selection is off while CI is set).',
			}
		);
	} finally {
		delete process.env.CI;
	}
} );

test( 'resolvePorts moves busy WordPress ports upward with autoPort', async () => {
	const resolved = await resolvePorts( makeConfig(), {
		environments: ENVIRONMENTS,
		autoPort: true,
		held: {},
		saved: {},
		isFree: freeExcept( [ 8888 ] ),
		randomPort: randomPorts( [ 50001, 50002 ] ),
	} );

	assert.equal( resolved.development.http, 8889 );
	assert.equal( resolved.tests.http, 8890 );
} );

test( 'resolvePorts keeps the ports the running containers publish', async () => {
	const resolved = await resolvePorts( makeConfig(), {
		environments: ENVIRONMENTS,
		autoPort: true,
		held: {
			development: { http: 8890, mysql: 50010 },
			tests: { http: 8889, mysql: 50011 },
		},
		saved: {},
		isFree: freeExcept( [ 8888, 8889, 8890, 50010, 50011 ] ),
		randomPort: randomPorts( [] ),
	} );

	assert.deepEqual( resolved, {
		development: { http: 8890, mysql: 50010 },
		tests: { http: 8889, mysql: 50011 },
	} );
} );

test( 'resolvePorts moves a running site back to its port when autoPort is off', async () => {
	const resolved = await resolvePorts( makeConfig(), {
		environments: [ 'development' ],
		autoPort: false,
		held: { development: { http: 8890 } },
		saved: {},
		isFree: freeExcept( [] ),
		randomPort: randomPorts( [ 50001 ] ),
	} );

	assert.equal( resolved.development.http, 8888 );
} );

test( 'resolvePorts reuses a free saved MariaDB port and replaces a busy one', async () => {
	const resolved = await resolvePorts( makeConfig(), {
		environments: ENVIRONMENTS,
		autoPort: false,
		held: {},
		saved: { development: { mysql: 50020 }, tests: { mysql: 50021 } },
		isFree: freeExcept( [ 50021 ] ),
		randomPort: randomPorts( [ 50030 ] ),
	} );

	assert.equal( resolved.development.mysql, 50020 );
	assert.equal( resolved.tests.mysql, 50030 );
} );

test( 'resolvePorts requires a configured mysqlPort to be free', async () => {
	const config = makeConfig();
	config.env.tests.mysqlPort = 13307;

	await assert.rejects(
		resolvePorts( config, {
			environments: ENVIRONMENTS,
			autoPort: true,
			held: {},
			saved: {},
			isFree: freeExcept( [ 13307 ] ),
			randomPort: randomPorts( [ 50001 ] ),
		} ),
		/^Error: Port 13307 \(tests database\) is already in use\. Free it, set another "mysqlPort"/
	);
} );

test( 'resolvePorts never hands one port to two roles', async () => {
	const config = makeConfig();
	config.env.development.mysqlPort = 8889;

	await assert.rejects(
		resolvePorts( config, {
			environments: ENVIRONMENTS,
			autoPort: false,
			held: {},
			saved: {},
			isFree: freeExcept( [] ),
			randomPort: randomPorts( [] ),
		} ),
		/Port 8889 \(database\) is already in use/
	);

	const resolved = await resolvePorts( makeConfig(), {
		environments: ENVIRONMENTS,
		autoPort: false,
		held: { tests: { http: 8889 } },
		saved: { development: { mysql: 8889 } },
		isFree: freeExcept( [] ),
		randomPort: randomPorts( [ 8888, 50001, 50002 ] ),
	} );
	assert.deepEqual( resolved.development, { http: 8888, mysql: 50001 } );
} );

test( 'resolvePorts moves a running site to its changed port when that port is free', async () => {
	const config = makeConfig();
	config.env.development.port = 8935;
	const request = {
		environments: [ 'development' ],
		autoPort: true,
		held: { development: { http: 8930 } },
		saved: {},
		randomPort: randomPorts( [ 50001 ] ),
	};

	const moved = await resolvePorts( config, {
		...request,
		isFree: freeExcept( [ 8930 ] ),
	} );
	const kept = await resolvePorts( config, {
		...request,
		isFree: freeExcept( [ 8930, 8935 ] ),
	} );

	assert.equal( moved.development.http, 8935 );
	assert.equal( kept.development.http, 8930 );
} );

test( 'resolvePorts gives the tests database a random port when both environments share one mysqlPort', async () => {
	const config = makeConfig();
	config.env.development.mysqlPort = 13306;
	config.env.tests.mysqlPort = 13306;
	const messages = [];
	const request = {
		environments: ENVIRONMENTS,
		autoPort: false,
		held: {},
		isFree: freeExcept( [] ),
		log: ( message ) => messages.push( message ),
	};

	const reused = await resolvePorts( config, {
		...request,
		saved: { tests: { mysql: 50021 } },
		randomPort: randomPorts( [] ),
	} );
	const random = await resolvePorts( config, {
		...request,
		saved: { tests: { mysql: 13306 } },
		randomPort: randomPorts( [ 50030 ] ),
	} );

	assert.equal( reused.development.mysql, 13306 );
	assert.equal( reused.tests.mysql, 50021 );
	assert.equal( random.development.mysql, 13306 );
	assert.equal( random.tests.mysql, 50030 );
	assert.deepEqual( messages, [
		'Tests database uses port 50021; "mysqlPort" 13306 belongs to the development database.',
		'Tests database uses port 50030; "mysqlPort" 13306 belongs to the development database.',
	] );
} );

/**
 * @param {Object} [development] Values merged into the development environment.
 * @param {Object} [tests]       Values merged into the tests environment.
 * @return {Object} A config whose environments run phpMyAdmin.
 */
function phpmyadminConfig( development = {}, tests = {} ) {
	const config = makeConfig();
	Object.assign( config.env.development, { phpmyadmin: true }, development );
	Object.assign( config.env.tests, { phpmyadmin: true }, tests );
	return config;
}

const PHPMYADMIN_REQUEST = {
	environments: ENVIRONMENTS,
	autoPort: false,
	held: {},
	saved: {},
	isFree: freeExcept( [] ),
};

test( 'resolvePorts picks no phpMyAdmin port where phpmyadmin is off', async () => {
	const config = phpmyadminConfig( {}, { phpmyadmin: false } );
	config.env.tests.phpmyadminPort = 8995;

	const resolved = await resolvePorts( config, {
		...PHPMYADMIN_REQUEST,
		randomPort: randomPorts( [ 50001, 50002, 50003 ] ),
	} );

	assert.deepEqual( resolved, {
		development: { http: 8888, mysql: 50001, phpmyadmin: 50003 },
		tests: { http: 8889, mysql: 50002 },
	} );
} );

test( 'resolvePorts gives phpMyAdmin a random port, then reuses the saved one while it is free', async () => {
	const config = phpmyadminConfig();

	const random = await resolvePorts( config, {
		...PHPMYADMIN_REQUEST,
		randomPort: randomPorts( [ 50001, 50002, 50003, 50004 ] ),
	} );
	const reused = await resolvePorts( config, {
		...PHPMYADMIN_REQUEST,
		saved: {
			development: { phpmyadmin: 50031 },
			tests: { phpmyadmin: 50032 },
		},
		randomPort: randomPorts( [ 50001, 50002 ] ),
	} );
	const busy = await resolvePorts( config, {
		...PHPMYADMIN_REQUEST,
		saved: { development: { phpmyadmin: 50031 } },
		isFree: freeExcept( [ 50031 ] ),
		randomPort: randomPorts( [ 50001, 50002, 50033, 50034 ] ),
	} );

	assert.equal( random.development.phpmyadmin, 50003 );
	assert.equal( random.tests.phpmyadmin, 50004 );
	assert.equal( reused.development.phpmyadmin, 50031 );
	assert.equal( reused.tests.phpmyadmin, 50032 );
	assert.equal( busy.development.phpmyadmin, 50033 );
} );

test( 'resolvePorts keeps a running phpMyAdmin on its port', async () => {
	const resolved = await resolvePorts( phpmyadminConfig(), {
		...PHPMYADMIN_REQUEST,
		held: { development: { phpmyadmin: 50041 } },
		isFree: freeExcept( [ 50041 ] ),
		randomPort: randomPorts( [ 50001, 50002, 50004 ] ),
	} );

	assert.equal( resolved.development.phpmyadmin, 50041 );
} );

test( 'resolvePorts requires a configured phpmyadminPort to be free', async () => {
	const config = phpmyadminConfig( {}, { phpmyadminPort: 8995 } );

	const resolved = await resolvePorts( config, {
		...PHPMYADMIN_REQUEST,
		randomPort: randomPorts( [ 50001, 50002, 50003 ] ),
	} );
	await assert.rejects(
		resolvePorts( config, {
			...PHPMYADMIN_REQUEST,
			isFree: freeExcept( [ 8995 ] ),
			randomPort: randomPorts( [ 50001, 50002, 50003 ] ),
		} ),
		/^Error: Port 8995 \(tests phpMyAdmin\) is already in use\. Free it, set another "phpmyadminPort"/
	);

	assert.equal( resolved.tests.phpmyadmin, 8995 );
} );

test( 'resolvePorts reserves a configured phpmyadminPort before random ports', async () => {
	const config = phpmyadminConfig( { phpmyadminPort: 50001 } );

	const resolved = await resolvePorts( config, {
		...PHPMYADMIN_REQUEST,
		randomPort: randomPorts( [ 50001, 50002, 50003, 50004 ] ),
	} );

	assert.equal( resolved.development.phpmyadmin, 50001 );
	assert.equal( resolved.development.mysql, 50002 );
} );

test( 'resolvePorts gives the tests phpMyAdmin a random port when both environments share one phpmyadminPort', async () => {
	const config = phpmyadminConfig(
		{ phpmyadminPort: 8995 },
		{ phpmyadminPort: 8995 }
	);
	const messages = [];

	const resolved = await resolvePorts( config, {
		...PHPMYADMIN_REQUEST,
		log: ( message ) => messages.push( message ),
		randomPort: randomPorts( [ 50001, 50002, 50030 ] ),
	} );

	assert.equal( resolved.development.phpmyadmin, 8995 );
	assert.equal( resolved.tests.phpmyadmin, 50030 );
	assert.deepEqual( messages, [
		'Tests phpMyAdmin uses port 50030; "phpmyadminPort" 8995 belongs to the development phpMyAdmin.',
	] );
} );

test( 'resolvePorts keeps distinct configured mysqlPort values strict', async () => {
	const config = makeConfig();
	config.env.development.mysqlPort = 13306;
	config.env.tests.mysqlPort = 13307;

	const resolved = await resolvePorts( config, {
		environments: ENVIRONMENTS,
		autoPort: false,
		held: {},
		saved: {},
		isFree: freeExcept( [] ),
		randomPort: randomPorts( [] ),
	} );

	assert.equal( resolved.development.mysql, 13306 );
	assert.equal( resolved.tests.mysql, 13307 );
} );

test( 'resolvePorts reserves configured ports before saved, random and automatic ones', async () => {
	const config = makeConfig();
	config.env.tests.mysqlPort = 13307;

	const saved = await resolvePorts( config, {
		environments: ENVIRONMENTS,
		autoPort: false,
		held: {},
		saved: { development: { mysql: 13307 } },
		isFree: freeExcept( [] ),
		randomPort: randomPorts( [ 13307, 50040 ] ),
	} );
	config.env.tests.mysqlPort = 8890;
	const automatic = await resolvePorts( config, {
		environments: ENVIRONMENTS,
		autoPort: true,
		held: {},
		saved: {},
		isFree: freeExcept( [ 8888 ] ),
		randomPort: randomPorts( [ 50041 ] ),
	} );

	assert.deepEqual( saved.development, { http: 8888, mysql: 50040 } );
	assert.equal( saved.tests.mysql, 13307 );
	assert.deepEqual( automatic.development, { http: 8889, mysql: 50041 } );
	assert.deepEqual( automatic.tests, { http: 8891, mysql: 8890 } );
} );

test( 'isPortFree reports a port held on loopback as busy', async () => {
	const server = net.createServer();
	await new Promise( ( resolve ) =>
		server.listen( 0, '127.0.0.1', resolve )
	);
	const { port } = server.address();
	try {
		assert.equal( await isPortFree( port ), false );
	} finally {
		await new Promise( ( resolve ) => server.close( resolve ) );
	}
	assert.equal( await isPortFree( port ), true );
} );

test( 'pickRandomPort returns a free port', async () => {
	const port = await pickRandomPort();

	assert.ok( port > 0 );
	assert.equal( await isPortFree( port ), true );
} );
