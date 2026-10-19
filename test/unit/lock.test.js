'use strict';
const test = require( 'node:test' );
const assert = require( 'node:assert/strict' );
const fs = require( 'fs' );
const path = require( 'path' );
const { withLock } = require( '../../lib/lock' );
const { makeTempDir } = require( '../helpers/temp' );

const sleep = ( ms ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );

async function waitFor( predicate, timeoutMs = 5000 ) {
	const deadline = Date.now() + timeoutMs;
	while ( ! predicate() ) {
		if ( Date.now() > deadline ) {
			throw new Error( 'Timed out waiting for the condition.' );
		}
		await sleep( 10 );
	}
}

function makeDirectory() {
	return makeTempDir( 'wpec-lock-' );
}

test( 'a held lock blocks a second withLock until it is released', async () => {
	const directory = makeDirectory();
	let release;
	const released = new Promise( ( resolve ) => ( release = resolve ) );
	const order = [];

	const first = withLock( directory, async () => {
		order.push( 'first:start' );
		await released;
		order.push( 'first:end' );
	} );
	await waitFor( () => order.includes( 'first:start' ) );
	const second = withLock( directory, async () => order.push( 'second' ), {
		timeoutMs: 5000,
	} );

	// Two poll intervals pass while the lock is held.
	await sleep( 600 );
	assert.deepEqual( order, [ 'first:start' ] );

	release();
	await Promise.all( [ first, second ] );
	assert.deepEqual( order, [ 'first:start', 'first:end', 'second' ] );
	assert.equal( fs.existsSync( path.join( directory, '.lock' ) ), false );
} );

test( 'a held lock times out a second withLock', async () => {
	const directory = makeDirectory();
	fs.writeFileSync( path.join( directory, '.lock' ), String( process.pid ) );

	await assert.rejects(
		withLock( directory, async () => assert.fail( 'task must not run' ), {
			timeoutMs: 300,
		} ),
		new RegExp( `pid ${ process.pid }` )
	);
} );

test( 'a lock left by a dead process is taken over', async () => {
	const directory = makeDirectory();
	fs.writeFileSync( path.join( directory, '.lock' ), '999999' );

	const result = await withLock( directory, async () => 'ran', {
		timeoutMs: 300,
	} );

	assert.equal( result, 'ran' );
	assert.equal( fs.existsSync( path.join( directory, '.lock' ) ), false );
} );

test( 'a freshly created empty lock file is not taken over', async () => {
	const directory = makeDirectory();
	const lockPath = path.join( directory, '.lock' );
	fs.writeFileSync( lockPath, '' );

	await assert.rejects(
		withLock( directory, async () => assert.fail( 'task must not run' ), {
			timeoutMs: 300,
		} ),
		/pid unknown/
	);
	assert.equal( fs.existsSync( lockPath ), true );
} );

test( 'an empty lock file older than 10 s is taken over', async () => {
	const directory = makeDirectory();
	const lockPath = path.join( directory, '.lock' );
	fs.writeFileSync( lockPath, '' );
	const old = new Date( Date.now() - 60 * 1000 );
	fs.utimesSync( lockPath, old, old );

	const result = await withLock( directory, async () => 'ran', {
		timeoutMs: 300,
	} );

	assert.equal( result, 'ran' );
} );

test( 'two waiters racing for one stale lock never hold it together', async () => {
	const directory = makeDirectory();
	fs.writeFileSync( path.join( directory, '.lock' ), '999999' );
	let active = 0;
	let maxActive = 0;
	let finished = 0;
	const task = async () => {
		active++;
		maxActive = Math.max( maxActive, active );
		await sleep( 100 );
		active--;
		finished++;
	};

	await Promise.all( [
		withLock( directory, task, { timeoutMs: 5000 } ),
		withLock( directory, task, { timeoutMs: 5000 } ),
		withLock( directory, task, { timeoutMs: 5000 } ),
	] );

	await waitFor( () => finished === 3 );
	assert.equal( maxActive, 1 );
	assert.deepEqual( fs.readdirSync( directory ), [] );
} );

test( 'release tolerates the lock file being removed by the task', async () => {
	const directory = makeDirectory();

	await withLock( directory, async () => {
		fs.rmSync( directory, { recursive: true, force: true } );
	} );

	assert.equal( fs.existsSync( directory ), false );
} );

test( 'a waiter takes the lock after the holder deletes the lock directory', async () => {
	const directory = makeDirectory();
	const lockPath = path.join( directory, '.lock' );
	let release;
	const released = new Promise( ( resolve ) => ( release = resolve ) );
	let waiterHeld = false;
	let lockWhileWaiterHeld = null;

	const first = withLock( directory, async () => {
		await sleep( 300 );
		fs.rmSync( directory, { recursive: true, force: true } );
		await waitFor( () => waiterHeld );
	} );
	await sleep( 50 );
	const second = withLock(
		directory,
		async () => {
			waiterHeld = true;
			await released;
			lockWhileWaiterHeld = fs.existsSync( lockPath );
		},
		{ timeoutMs: 5000 }
	);

	await first;
	release();
	await second;
	assert.equal( lockWhileWaiterHeld, true );
	assert.equal( fs.existsSync( lockPath ), false );
} );
