'use strict';
const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const fs = require( 'fs' );
const path = require( 'path' );
const { makeTempDir } = require( '../helpers/temp' );
const {
	ContainerCLI,
	stripProgress,
	toRecord,
} = require( '../../lib/runtime/container-cli' );

test( 'toRecord flattens inspect JSON', () => {
	const record = toRecord( {
		configuration: {
			id: 'example-mysql',
			image: { reference: 'docker.io/library/mariadb:lts' },
			labels: { 'dev.wp-env-container.project': 'example' },
			publishedPorts: [ { hostPort: 8888, containerPort: 80 } ],
			initProcess: { environment: [ 'A=1' ] },
		},
		status: {
			state: 'running',
			networks: [ { ipv4Address: '192.168.64.25/24' } ],
		},
	} );

	assert.deepEqual( record, {
		name: 'example-mysql',
		state: 'running',
		image: 'docker.io/library/mariadb:lts',
		labels: { 'dev.wp-env-container.project': 'example' },
		ipAddress: '192.168.64.25',
		ports: [ { hostPort: 8888, containerPort: 80 } ],
		environment: [ 'A=1' ],
	} );
} );

test( 'toRecord exposes the image digest when present', () => {
	const digest = 'sha256:' + 'c'.repeat( 64 );
	const record = toRecord( {
		configuration: {
			id: 'example-admin',
			image: {
				reference: 'docker.io/library/phpmyadmin:latest',
				descriptor: { digest },
			},
		},
		status: 'running',
	} );
	assert.equal( record.imageDigest, digest );
	assert.equal( 'imageDigest' in toRecord( { id: 'x' } ), false );
} );

test( 'toRecord passes through the creation and start dates when present', () => {
	const record = toRecord( {
		configuration: {
			id: 'x',
			creationDate: '2030-01-01T00:00:00Z',
		},
		status: { state: 'stopped', startedDate: '2030-01-01T00:01:00Z' },
	} );
	const unstarted = toRecord( {
		configuration: { id: 'x' },
		status: 'stopped',
	} );

	assert.equal( record.creationDate, '2030-01-01T00:00:00Z' );
	assert.equal( record.startedDate, '2030-01-01T00:01:00Z' );
	assert.equal( 'creationDate' in unstarted, false );
	assert.equal( 'startedDate' in unstarted, false );
} );

test( 'toRecord tolerates a stopped container without networks', () => {
	const record = toRecord( {
		configuration: { id: 'x' },
		status: 'stopped',
	} );

	assert.equal( record.state, 'stopped' );
	assert.equal( record.ipAddress, null );
	assert.equal( record.image, null );
} );

test( 'exec kills a timed-out process', async () => {
	const cli = new ContainerCLI( '/bin/sleep' );
	const started = Date.now();

	const result = await cli.exec( [ '30' ], { timeoutMs: 100 } );

	assert.equal( result.timedOut, true );
	assert.ok( Date.now() - started < 5000 );
} );

test( 'exec kills a timed-out process when onTimeout never settles', async () => {
	const cli = new ContainerCLI( '/bin/sleep' );
	let cleanupStarted = false;
	const started = Date.now();

	const result = await cli.exec( [ '30' ], {
		timeoutMs: 100,
		onTimeout: () => {
			cleanupStarted = true;
			return new Promise( () => {} );
		},
		onTimeoutLimitMs: 200,
	} );

	assert.equal( cleanupStarted, true );
	assert.equal( result.timedOut, true );
	assert.ok( Date.now() - started < 5000 );
} );

test( 'stripProgress removes image pull progress lines', () => {
	assert.equal(
		stripProgress(
			'[1/6] Fetching image [0s]\nhello\n[6/6] Starting container [1s]\nworld'
		),
		'hello\nworld'
	);
} );

/**
 * A ContainerCLI whose `exec` answers every call with `result`.
 *
 * @param {{stdout?: string, stderr?: string, exitCode?: number}} result Fields of the `exec` result to return.
 * @return {ContainerCLI} The stubbed CLI.
 */
function answering( result ) {
	const cli = new ContainerCLI( '/nonexistent' );
	cli.exec = async () => ( {
		stdout: '',
		stderr: '',
		timedOut: false,
		exitCode: 0,
		...result,
	} );
	return cli;
}

test( 'hostGateway reads the default network gateway', async () => {
	const cli = answering( {
		stdout: JSON.stringify( [
			{
				id: 'default',
				status: {
					ipv4Gateway: '192.168.65.1',
					ipv4Subnet: '192.168.65.0/24',
				},
			},
		] ),
	} );

	assert.equal( await cli.hostGateway(), '192.168.65.1' );
} );

test( 'hostGateway falls back to 192.168.64.1', async () => {
	assert.equal(
		await answering( { exitCode: 1 } ).hostGateway(),
		'192.168.64.1'
	);
	assert.equal(
		await answering( { stdout: 'not json' } ).hostGateway(),
		'192.168.64.1'
	);
	assert.equal(
		await answering( { stdout: '[{"status":{}}]' } ).hostGateway(),
		'192.168.64.1'
	);
} );

test( 'listImages returns image names', async () => {
	const cli = answering( {
		stdout: JSON.stringify( [
			{
				configuration: { name: 'docker.io/library/mariadb:lts' },
				id: 'a',
			},
			{
				configuration: { name: 'wp-env-container/cli:php8.3-0123abcd' },
				id: 'b',
			},
		] ),
	} );

	assert.deepEqual( await cli.listImages(), [
		'docker.io/library/mariadb:lts',
		'wp-env-container/cli:php8.3-0123abcd',
	] );
} );

test( 'imageDigest reads the digest the local tag points to', async () => {
	const digest = 'sha256:' + 'd'.repeat( 64 );
	const cli = answering( {
		stdout: JSON.stringify( [
			{ configuration: { descriptor: { digest } } },
		] ),
	} );
	assert.equal( await cli.imageDigest( 'phpmyadmin' ), digest );
} );

test( 'imageDigest is null for a missing image or unreadable output', async () => {
	assert.equal(
		await answering( { exitCode: 1 } ).imageDigest( 'phpmyadmin' ),
		null
	);
	assert.equal(
		await answering( { stdout: 'not json' } ).imageDigest( 'phpmyadmin' ),
		null
	);
	assert.equal(
		await answering( { stdout: '[]' } ).imageDigest( 'phpmyadmin' ),
		null
	);
} );

test( 'exec writes the command and its exit to stderr in debug mode', async () => {
	let output = '';
	const cli = new ContainerCLI( '/bin/echo', {
		debug: true,
		stderr: { write: ( text ) => ( output += text ) },
	} );

	await cli.exec( [ 'hello', 'world' ] );

	const lines = output.trimEnd().split( '\n' );
	assert.equal( lines[ 0 ], '$ container hello world' );
	assert.match( lines[ 1 ], /^→ exit 0 \(\d+ ms\)$/ );
} );

test( 'exec writes nothing to stderr without debug', async () => {
	let output = '';
	const cli = new ContainerCLI( '/bin/echo', {
		debug: false,
		stderr: { write: ( text ) => ( output += text ) },
	} );

	await cli.exec( [ 'hello' ] );

	assert.equal( output, '' );
} );

test( 'a ContainerCLI treats WP_ENV_CONTAINER_DEBUG=0 as debug off', () => {
	const saved = process.env.WP_ENV_CONTAINER_DEBUG;
	try {
		process.env.WP_ENV_CONTAINER_DEBUG = '0';
		assert.equal( new ContainerCLI( '/bin/true' ).debug, false );
		process.env.WP_ENV_CONTAINER_DEBUG = '1';
		assert.equal( new ContainerCLI( '/bin/true' ).debug, true );
	} finally {
		if ( saved === undefined ) {
			delete process.env.WP_ENV_CONTAINER_DEBUG;
		} else {
			process.env.WP_ENV_CONTAINER_DEBUG = saved;
		}
	}
} );

test( 'inspect kills a hung process after its timeout and reports no container', async () => {
	const dir = makeTempDir( 'wpec-inspect-' );
	const binaryPath = path.join( dir, 'container' );
	fs.writeFileSync( binaryPath, '#!/bin/sh\nexec sleep 30\n', {
		mode: 0o755,
	} );
	const cli = new ContainerCLI( binaryPath );

	const started = Date.now();
	const record = await cli.inspect( 'example-container', { timeoutMs: 200 } );

	assert.equal( record, null );
	assert.ok( Date.now() - started < 5000 );
} );
